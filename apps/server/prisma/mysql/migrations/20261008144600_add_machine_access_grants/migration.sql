CREATE TABLE `MachineAccountGrant` (
    `machineId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`machineId`, `accountId`),
    CONSTRAINT `MachineAccountGrant_accessLevel_check` CHECK (`accessLevel` IN ('view', 'admin'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `MachineTeamGrant` (
    `machineId` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`machineId`, `teamId`),
    CONSTRAINT `MachineTeamGrant_accessLevel_check` CHECK (`accessLevel` IN ('view', 'admin'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `MachineGroupGrant` (
    `machineId` VARCHAR(191) NOT NULL,
    `teamGroupId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`machineId`, `teamGroupId`),
    CONSTRAINT `MachineGroupGrant_accessLevel_check` CHECK (`accessLevel` IN ('view', 'admin'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `MachineKeyEnvelope` (
    `machineId` VARCHAR(191) NOT NULL,
    `recipientAccountId` VARCHAR(191) NOT NULL,
    `encryptedDataKey` BLOB NOT NULL,
    `machineOwnerEnvelopeFingerprint` VARCHAR(191) NOT NULL,
    `recipientContentPublicKeyFingerprint` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`machineId`, `recipientAccountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `MachineAccountGrant_accountId_machineId_idx` ON `MachineAccountGrant`(`accountId`, `machineId`);
CREATE INDEX `MachineTeamGrant_teamId_machineId_idx` ON `MachineTeamGrant`(`teamId`, `machineId`);
CREATE INDEX `MachineGroupGrant_teamGroupId_machineId_idx` ON `MachineGroupGrant`(`teamGroupId`, `machineId`);
CREATE INDEX `MachineKeyEnvelope_recipientAccountId_machineId_idx` ON `MachineKeyEnvelope`(`recipientAccountId`, `machineId`);

ALTER TABLE `MachineAccountGrant` ADD CONSTRAINT `MachineAccountGrant_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineAccountGrant` ADD CONSTRAINT `MachineAccountGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineAccountGrant` ADD CONSTRAINT `MachineAccountGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineTeamGrant` ADD CONSTRAINT `MachineTeamGrant_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineTeamGrant` ADD CONSTRAINT `MachineTeamGrant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineTeamGrant` ADD CONSTRAINT `MachineTeamGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineGroupGrant` ADD CONSTRAINT `MachineGroupGrant_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineGroupGrant` ADD CONSTRAINT `MachineGroupGrant_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineGroupGrant` ADD CONSTRAINT `MachineGroupGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineKeyEnvelope` ADD CONSTRAINT `MachineKeyEnvelope_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `MachineKeyEnvelope` ADD CONSTRAINT `MachineKeyEnvelope_recipientAccountId_fkey` FOREIGN KEY (`recipientAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
