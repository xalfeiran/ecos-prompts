require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { PrismaClient } = require('@prisma/client')
const openai = require('./openaiClient') // 👈 import OpenAI client

async function extractKeywords(text, language = 'es') {
  const prompt = `
Extrae las 5 palabras clave más importantes del siguiente texto en formato JSON:
Texto: "${text}"
Formato: ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
  `.trim()

  const completion = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  })

  const responseText = completion.choices[0].message.content.trim()

  try {
    const parsed = JSON.parse(responseText)
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    console.warn('⚠️ No se pudieron parsear las keywords:', responseText)
    return []
  }
}

const app = express()
const prisma = new PrismaClient()

app.use(cors())
app.use(express.json())

// ✅ GET /api/prompts - random prompt (with optional ?category=name)
app.get('/api/prompts', async (req, res) => {
  const category = req.query.category

  try {
    let prompt

    if (category) {
      const prompts = await prisma.prompt.findMany({
        where: {
          categories: {
            some: {
              category: {
                name: category,
              },
            },
          },
        },
        include: {
          categories: {
            include: { category: true },
          },
        },
      })

      if (prompts.length === 0) {
        return res.status(404).json({ message: 'No prompts found for this category' })
      }

      prompt = prompts[Math.floor(Math.random() * prompts.length)]
    } else {
      const prompts = await prisma.prompt.findMany({
        include: {
          categories: {
            include: { category: true },
          },
        },
      })

      if (prompts.length === 0) {
        return res.status(404).json({ message: 'No prompts available' })
      }

      prompt = prompts[Math.floor(Math.random() * prompts.length)]
    }

    res.json({
      id: prompt.id,
      prompt: prompt.text,
      language: prompt.language,
      categories: prompt.categories.map(c => c.category.name),
    })
  } catch (err) {
    console.error('Error fetching prompt:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ✅ POST /api/prompts/:id/event
app.post('/api/prompts/:id/event', async (req, res) => {
  const { id } = req.params
  const { type, metadata } = req.body

  if (!['fetched', 'used'].includes(type)) {
    return res.status(400).json({ error: 'Invalid event type' })
  }

  try {
    const event = await prisma.event.create({
      data: {
        promptId: id,
        type,
        metadata,
      },
    })

    res.status(201).json({ message: 'Event recorded', event })
  } catch (err) {
    console.error('Error recording event:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/categories', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: {
        parentId: null  // Solo categorías principales
      },
      include: {
        children: true
      }
    })

    const formatted = categories.map(cat => ({
      id: cat.id,
      name: cat.name,
      children: cat.children.map(child => ({
        id: child.id,
        name: child.name
      }))
    }))

    res.json(formatted)
  } catch (err) {
    console.error('Error fetching categories:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.get('/api/prompts/search', async (req, res) => {
  const { keyword } = req.query
  if (!keyword) return res.status(400).json({ error: 'Keyword required' })

  const prompts = await prisma.prompt.findMany({
    where: {
      keywords: {
        has: keyword
      }
    }
  })

  res.json({ prompts })
})

app.post('/api/prompts/generate', async (req, res) => {
  const { category, language = 'es', amount = 5, subcategories = [] } = req.body

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
`

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Eres un generador de frases sensibles para explorar recuerdos y emociones, mantenlo sencillo y cálido.' },
        { role: 'user', content: promptInstruction },
      ],
      temperature: 0.8,
    })

    const raw = response.choices[0].message.content
    const generated = raw.split('\n').filter(Boolean).map(line => line.replace(/^\d+[\).]?\s*/, '').trim())

    const saved = []

    for (const phrase of generated) {
      // 🧠 Extraer keywords para este prompt
      const keywordPrompt = `
Extrae 3 a 5 palabras clave relevantes del siguiente enunciado. Las palabras clave deben ser sustantivos o conceptos importantes. Devuélvelas como un arreglo JSON.

Texto: "${phrase}"
`
      let keywords = []

      try {
        const keywordResponse = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            { role: 'system', content: 'Eres un extractor de palabras clave útiles para clasificación.' },
            { role: 'user', content: keywordPrompt }
          ],
          temperature: 0.3
        })

        const keywordRaw = keywordResponse.choices[0].message.content.trim()

        // Intenta convertir a arreglo
        keywords = JSON.parse(keywordRaw)

        if (!Array.isArray(keywords)) {
          keywords = []
        }
      } catch (err) {
        console.warn(`⚠️ No se pudieron extraer keywords para "${phrase}"`)
      }

      // 💾 Guardar en la base de datos
      const newPrompt = await prisma.prompt.create({
        data: {
          text: phrase,
          language,
          keywords,
          categories: {
            create: [{
              category: {
                connectOrCreate: {
                  where: { name: category },
                  create: { name: category }
                }
              }
            }]
          }
        }
      })

      saved.push(newPrompt)
    }

    res.status(201).json({ message: 'Prompts generated', prompts: saved })

  } catch (err) {
    console.error('Error generating prompts:', err)
    res.status(500).json({ error: 'OpenAI generation failed' })
  }
})


// ✅ Basic hello
app.get('/test', (req, res) => {
  res.send('Prompt API is running 🎉')
})

// 🔐 ADMIN: GET /api/admin/prompts - Get all prompts (requires admin API key)
app.get('/api/admin/prompts', async (req, res) => {
  // Check for admin API key in headers
  const adminApiKey = req.headers['x-admin-api-key'] || req.headers['authorization']?.replace('Bearer ', '')
  
  if (!adminApiKey || adminApiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ 
      error: 'Unauthorized', 
      message: 'Valid admin API key required' 
    })
  }

  try {
    // Get all prompts with their categories and events
    const prompts = await prisma.prompt.findMany({
      include: {
        categories: {
          include: { 
            category: true 
          }
        },
        events: {
          select: {
            id: true,
            type: true,
            metadata: true,
            createdAt: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    // Format the response
    const formattedPrompts = prompts.map(prompt => ({
      id: prompt.id,
      text: prompt.text,
      language: prompt.language,
      source: prompt.source,
      keywords: prompt.keywords,
      createdAt: prompt.createdAt,
      categories: prompt.categories.map(c => c.category.name),
      eventCount: prompt.events.length,
      events: prompt.events
    }))

    res.json({
      success: true,
      totalPrompts: formattedPrompts.length,
      prompts: formattedPrompts
    })

  } catch (err) {
    console.error('Error fetching all prompts:', err)
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to retrieve prompts' 
    })
  }
})

// 🔐 ADMIN: GET /api/admin/prompts/summary - Get prompts summary by category (requires admin API key)
app.get('/api/admin/prompts/summary', async (req, res) => {
  // Check for admin API key in headers
  const adminApiKey = req.headers['x-admin-api-key'] || req.headers['authorization']?.replace('Bearer ', '')
  
  if (!adminApiKey || adminApiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ 
      error: 'Unauthorized', 
      message: 'Valid admin API key required' 
    })
  }

  try {
    // Get all prompts with their categories
    const prompts = await prisma.prompt.findMany({
      include: {
        categories: {
          include: { 
            category: true 
          }
        }
      }
    })

    // Create category summary
    const categorySummary = {}
    let totalPrompts = 0

    prompts.forEach(prompt => {
      totalPrompts++
      
      prompt.categories.forEach(cat => {
        const categoryName = cat.category.name
        
        if (!categorySummary[categoryName]) {
          categorySummary[categoryName] = {
            name: categoryName,
            count: 0,
            prompts: []
          }
        }
        
        categorySummary[categoryName].count++
        categorySummary[categoryName].prompts.push({
          id: prompt.id,
          text: prompt.text,
          language: prompt.language,
          createdAt: prompt.createdAt
        })
      })
    })

    // Convert to array and sort by count (descending)
    const summaryArray = Object.values(categorySummary).sort((a, b) => b.count - a.count)

    res.json({
      success: true,
      totalPrompts,
      totalCategories: summaryArray.length,
      summary: summaryArray,
      categoryBreakdown: categorySummary
    })

  } catch (err) {
    console.error('Error fetching prompts summary:', err)
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to retrieve prompts summary' 
    })
  }
})

// ✅ Start server
const PORT = process.env.PORT || 5001
app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`)
})

