-- AlterEnum
ALTER TYPE "AutomationScheduleKind" ADD VALUE 'manual';

-- AlterTable
ALTER TABLE "AutomationRun" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_automationId_idempotencyKey_key" ON "AutomationRun"("automationId", "idempotencyKey");
