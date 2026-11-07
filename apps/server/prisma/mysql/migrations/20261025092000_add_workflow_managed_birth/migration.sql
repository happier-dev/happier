ALTER TABLE `AutomationRun` ADD COLUMN `managedCreationId` VARCHAR(191) NULL;
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_managedCreationId_fkey` FOREIGN KEY (`managedCreationId`) REFERENCES `ManagedMachine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX `AutomationRun_account_managed_creation_idx` ON `AutomationRun`(`accountId`, `managedCreationId`);
