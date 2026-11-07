-- Tasks retain their content in UserKVStore and share through explicit resource grants.

CREATE TABLE `TaskAccountGrant` (
    `taskId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'edit', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`taskId`, `accountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TaskTeamGrant` (
    `taskId` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'edit', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`taskId`, `teamId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TaskGroupGrant` (
    `taskId` VARCHAR(191) NOT NULL,
    `teamGroupId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'edit', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`taskId`, `teamGroupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TaskKeyEnvelope` (
    `taskId` VARCHAR(191) NOT NULL,
    `recipientAccountId` VARCHAR(191) NOT NULL,
    `encryptedDataKey` LONGBLOB NOT NULL,
    `recipientContentPublicKeyFingerprint` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`taskId`, `recipientAccountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `TaskAccountGrant_accountId_taskId_idx` ON `TaskAccountGrant`(`accountId`, `taskId`);

CREATE INDEX `TaskTeamGrant_teamId_taskId_idx` ON `TaskTeamGrant`(`teamId`, `taskId`);

CREATE INDEX `TaskGroupGrant_teamGroupId_taskId_idx` ON `TaskGroupGrant`(`teamGroupId`, `taskId`);

CREATE INDEX `TaskKeyEnvelope_recipientAccountId_taskId_idx` ON `TaskKeyEnvelope`(`recipientAccountId`, `taskId`);

ALTER TABLE `TaskAccountGrant` ADD CONSTRAINT `TaskAccountGrant_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `UserKVStore`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskAccountGrant` ADD CONSTRAINT `TaskAccountGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskAccountGrant` ADD CONSTRAINT `TaskAccountGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TaskTeamGrant` ADD CONSTRAINT `TaskTeamGrant_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `UserKVStore`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskTeamGrant` ADD CONSTRAINT `TaskTeamGrant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskTeamGrant` ADD CONSTRAINT `TaskTeamGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TaskGroupGrant` ADD CONSTRAINT `TaskGroupGrant_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `UserKVStore`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskGroupGrant` ADD CONSTRAINT `TaskGroupGrant_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskGroupGrant` ADD CONSTRAINT `TaskGroupGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TaskKeyEnvelope` ADD CONSTRAINT `TaskKeyEnvelope_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `UserKVStore`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TaskKeyEnvelope` ADD CONSTRAINT `TaskKeyEnvelope_recipientAccountId_fkey` FOREIGN KEY (`recipientAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
