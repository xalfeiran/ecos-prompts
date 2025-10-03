/*
  Warnings:

  - The primary key for the `PromptCategory` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[promptId,categoryId]` on the table `PromptCategory` will be added. If there are existing duplicate values, this will fail.
  - The required column `id` was added to the `PromptCategory` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- DropForeignKey
ALTER TABLE "PromptCategory" DROP CONSTRAINT "PromptCategory_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "PromptCategory" DROP CONSTRAINT "PromptCategory_promptId_fkey";

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "PromptCategory" DROP CONSTRAINT "PromptCategory_pkey",
ADD COLUMN     "id" TEXT NOT NULL,
ADD CONSTRAINT "PromptCategory_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE UNIQUE INDEX "PromptCategory_promptId_categoryId_key" ON "PromptCategory"("promptId", "categoryId");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptCategory" ADD CONSTRAINT "PromptCategory_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "Prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptCategory" ADD CONSTRAINT "PromptCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
