ALTER TABLE `UsageEvent` ADD COLUMN `idempotencyKey` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `UsageEvent_idempotencyKey_key` ON `UsageEvent`(`idempotencyKey`);
