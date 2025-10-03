const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  // Crear categorías principales
  const infancia = await prisma.category.create({
    data: { name: 'Infancia' }
  })

  const escuela = await prisma.category.create({
    data: { name: 'Escuela', parentId: infancia.id }
  })

  const juegos = await prisma.category.create({
    data: { name: 'Juegos', parentId: infancia.id }
  })

  const familia = await prisma.category.create({
    data: { name: 'Familia' }
  })

  // Crear prompts con relaciones
  const prompt1 = await prisma.prompt.create({
    data: {
      text: '¿Cómo era la calle donde vivías cuando eras niño?',
      language: 'es',
      categories: {
        create: [
          { categoryId: infancia.id }
        ]
      }
    }
  })

  const prompt2 = await prisma.prompt.create({
    data: {
      text: '¿Qué juegos solías jugar en la escuela?',
      language: 'es',
      categories: {
        create: [
          { categoryId: escuela.id },
          { categoryId: juegos.id }
        ]
      }
    }
  })

  const prompt3 = await prisma.prompt.create({
    data: {
      text: '¿Qué recuerdo especial tienes con tu familia?',
      language: 'es',
      categories: {
        create: [
          { categoryId: familia.id }
        ]
      }
    }
  })

  console.log('✅ Seed data created')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => {
    prisma.$disconnect()
  })
