ALTER TABLE `Session` ADD COLUMN `managedCreationId` VARCHAR(191) NULL;
ALTER TABLE `Session` ADD CONSTRAINT `Session_managedCreationId_fkey` FOREIGN KEY (`managedCreationId`) REFERENCES `ManagedMachine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX `Session_account_managed_creation_idx` ON `Session`(`accountId`, `managedCreationId`);
