-- Add explicit installation identity and machine replacement metadata.
ALTER TABLE `Machine` ADD COLUMN `installationId` VARCHAR(191) NULL,
    ADD COLUMN `installationPublicKey` LONGBLOB NULL,
    ADD COLUMN `contentPublicKeyFingerprint` VARCHAR(191) NULL,
    ADD COLUMN `replacedByMachineId` VARCHAR(191) NULL,
    ADD COLUMN `replacedAt` DATETIME(3) NULL,
    ADD COLUMN `replacementReason` VARCHAR(191) NULL,
    ADD COLUMN `replacementSource` VARCHAR(191) NULL,
    ADD COLUMN `replacementActorUserId` VARCHAR(191) NULL;

CREATE INDEX `Machine_accountId_installationId_idx` ON `Machine`(`accountId`, `installationId`);
CREATE INDEX `Machine_accountId_replacedByMachineId_idx` ON `Machine`(`accountId`, `replacedByMachineId`);
CREATE INDEX `Machine_accountId_replacedAt_idx` ON `Machine`(`accountId`, `replacedAt`);
