-- AlterTable
ALTER TABLE `AutomationRun` ADD COLUMN `idempotencyKey` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `AutomationRun_automationId_idempotencyKey_key` ON `AutomationRun`(`automationId`, `idempotencyKey`);
