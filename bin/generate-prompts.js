#!/usr/bin/env node

require('dotenv').config()

const { MongoClient } = require('mongodb')
const openai = require('../openaiClient')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue

    const [keyRaw, maybeValue] = token.split('=')
    const key = keyRaw.replace(/^--/, '')
    let value = maybeValue

    if (typeof value === 'undefined') {
      // support space-separated values: --flag value
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[i + 1]
        i++
      } else {
        value = true
      }
    }

    args[key] = value
  }
  return args
}

function buildMongoUri(args) {
  const explicitUri = args['mongodb-uri'] || args.mongo || args['atlas-uri'] || process.env.MONGODB_URI
  const authSource = args['mongo-authSource'] || args.authSource
  const extraParams = args['mongo-params'] // e.g. retryWrites=true&w=majority

  if (explicitUri) {
    let uri = explicitUri
    // If mongodb+srv, don't auto-append authSource (Atlas typically doesn't need it)
    const isSrv = /^mongodb\+srv:/.test(uri)
    if (!isSrv && authSource) {
      const hasQuery = uri.includes('?')
      const sep = hasQuery ? '&' : '?'
      if (!/([?&])authSource=/.test(uri)) {
        uri = `${uri}${sep}authSource=${encodeURIComponent(authSource)}`
      }
    }
    if (extraParams) {
      const hasQuery = uri.includes('?')
      const sep = hasQuery ? '&' : '?'
      uri = `${uri}${sep}${extraParams}`
    }
    return uri
  }

  // Build SRV URI for Atlas when cluster is provided
  const atlasCluster = args['atlas-cluster'] // e.g., cluster0.xxxxxx.mongodb.net
  const host = args['mongo-host'] || '127.0.0.1'
  const port = String(args['mongo-port'] || 27017)
  const db   = args['mongo-db'] || 'memoryprompts'
  const user = args['mongo-user']
  const pass = args['mongo-pass']

  const creds = (user && pass)
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    : ''

  if (atlasCluster) {
    const base = `mongodb+srv://${creds}${atlasCluster}/${db}`
    const defaults = 'retryWrites=true&w=majority'
    const qsParts = []
    if (extraParams) qsParts.push(extraParams)
    // authSource typically not used with SRV; skip unless explicitly provided in extraParams
    const query = qsParts.length > 0 ? `?${qsParts.join('&')}` : `?${defaults}`
    return `${base}${query}`
  }

  const params = []
  if (authSource) params.push(`authSource=${encodeURIComponent(authSource)}`)
  if (extraParams) params.push(extraParams)
  const query = params.length > 0 ? `?${params.join('&')}` : ''
  return `mongodb://${creds}${host}:${port}/${db}${query}`
}

function sanitizeUriForLog(uri) {
  try {
    const u = new URL(uri)
    if (u.password) {
      u.password = '***'
    }
    return `${u.protocol}//${u.username ? `${u.username}${u.password ? ':' + u.password : ''}@` : ''}${u.host}${u.pathname}${u.search}`
  } catch {
    return uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+):[^@]+@/i, '$1:***@')
  }
}

async function extractKeywords(text) {
  const instruction = `
Extrae 3 a 5 palabras clave relevantes del siguiente enunciado. Las palabras clave deben ser sustantivos o conceptos importantes. Devuélvelas como un arreglo JSON.

Texto: "${text}"
`.trim()

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Eres un extractor de palabras clave útiles para clasificación.' },
        { role: 'user', content: instruction }
      ],
      temperature: 0.3
    })

    const raw = response.choices?.[0]?.message?.content?.trim() || '[]'
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.warn('⚠️  No se pudieron extraer keywords:', err?.message || err)
    return []
  }
}

async function generatePrompts({ category, language = 'es', amount = 5, subcategories = [] }) {
  const context = subcategories.length > 0
    ? `En particular, enfócate en los siguientes temas: ${subcategories.join(', ')}.`
    : ''

  const promptInstruction = `
Genera ${amount} preguntas en ${language === 'es' ? 'español' : 'inglés'} que inviten a una persona a recordar momentos personales relacionados con el tema "${category}".
${context}

✅ Las preguntas deben:
- Ser claras y directas
- Estar formuladas como si alguien entrevistara con cariño a un familiar
- Evocar memorias específicas (ej. lugares, personas, emociones)

❌ No incluyas frases poéticas, reflexiones filosóficas ni metáforas.

Responde solamente con la lista de preguntas, una por línea.
`.trim()

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'Eres un generador de frases sensibles para explorar recuerdos y emociones, mantenlo sencillo y cálido.' },
      { role: 'user', content: promptInstruction }
    ],
    temperature: 0.8
  })

  const raw = response.choices?.[0]?.message?.content || ''
  const generated = raw
    .split('\n')
    .map(line => line.replace(/^\s*\d+[\).]?\s*/, '').trim())
    .filter(Boolean)

  return generated
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const category = args.category || args.c
  const language = (args.language || args.lang || 'es').toLowerCase()
  const amount = parseInt(args.amount || args.n || '5', 10)
  const subs = (args.subcategories || args.subs || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const dryRun = Boolean(args['dry-run'] || args.dry)
  const collectionName = args['collection'] || 'prompts'

  const mongoUri = buildMongoUri(args) || 'mongodb://127.0.0.1:27017/memoryprompts'

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Falta OPENAI_API_KEY en el entorno (.env)')
    process.exit(1)
  }

  if (!category) {
    console.error('❌ Debes especificar --category "Nombre"')
    process.exit(1)
  }

  console.log('🧠 Generando prompts...')
  const phrases = await generatePrompts({ category, language, amount, subcategories: subs })
  console.log(`✅ Generados ${phrases.length} prompts`)

  console.log('🔎 Extrayendo keywords...')
  const docs = []
  for (const phrase of phrases) {
    const keywords = await extractKeywords(phrase)
    docs.push({
      text: phrase,
      language,
      keywords,
      categories: [category],
      subcategories: subs,
      source: 'openai',
      model: 'gpt-4',
      createdAt: new Date()
    })
  }

  if (dryRun) {
    console.log('🚫 Dry run activado: no se guardarán datos en MongoDB.')
    console.log(JSON.stringify({
      category,
      language,
      amount,
      subcategories: subs,
      prompts: docs
    }, null, 2))
    return
  }

  console.log(`💾 Conectando a MongoDB: ${sanitizeUriForLog(mongoUri)}`)
  const client = new MongoClient(mongoUri)

  try {
    await client.connect()
    // If database name not provided in the URI, fallback to 'memoryprompts'
    const dbNameFromUri = (() => {
      try {
        const url = new URL(mongoUri)
        const pathname = (url.pathname || '').replace(/^\//, '')
        return pathname || 'memoryprompts'
      } catch {
        return 'memoryprompts'
      }
    })()

    const db = client.db(dbNameFromUri)
    console.log(`📚 Base de datos: ${db.databaseName} | 📄 Colección: ${collectionName}`)
    const collection = db.collection(collectionName)
    const result = await collection.insertMany(docs, { ordered: false })

    console.log(`✅ Insertados ${Object.keys(result.insertedIds).length} documentos en la colección 'prompts'`)
    const inserted = Object.entries(result.insertedIds).map(([idx, id]) => ({
      _id: id && typeof id.toString === 'function' ? id.toString() : String(id),
      ...docs[Number(idx)]
    }))
    console.log(JSON.stringify({ insertedCount: inserted.length, prompts: inserted }, null, 2))
  } catch (err) {
    console.error('❌ Error guardando en MongoDB:', err?.message || err)
    process.exitCode = 1
  } finally {
    await client.close()
  }
}

main().catch(err => {
  console.error('❌ Error:', err?.message || err)
  process.exit(1)
})



