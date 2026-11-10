-- CreateTable
CREATE TABLE `PluginCollectionAccountGrant` (
    `rowDbId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'edit', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PluginCollectionAccountGrant_accountId_rowDbId_idx`(`accountId`, `rowDbId`),
    PRIMARY KEY (`rowDbId`, `accountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PluginCollectionTeamGrant` (
    `rowDbId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'edit', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PluginCollectionTeamGrant_teamId_rowDbId_idx`(`teamId`, `rowDbId`),
    PRIMARY KEY (`rowDbId`, `teamId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PluginCollectionGroupGrant` (
    `rowDbId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `teamGroupId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'edit', 'admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PluginCollectionGroupGrant_teamGroupId_rowDbId_idx`(`teamGroupId`, `rowDbId`),
    PRIMARY KEY (`rowDbId`, `teamGroupId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PluginCollectionKeyEnvelope` (
    `rowDbId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `recipientAccountId` VARCHAR(191) NOT NULL,
    `encryptedDataKey` LONGBLOB NOT NULL,
    `recipientContentPublicKeyFingerprint` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PluginCollectionKeyEnvelope_recipientAccountId_rowDbId_idx`(`recipientAccountId`, `rowDbId`),
    PRIMARY KEY (`rowDbId`, `recipientAccountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PluginCollectionAccountGrant` ADD CONSTRAINT `PluginCollectionAccountGrant_rowDbId_fkey` FOREIGN KEY (`rowDbId`) REFERENCES `PluginCollectionRow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionAccountGrant` ADD CONSTRAINT `PluginCollectionAccountGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionAccountGrant` ADD CONSTRAINT `PluginCollectionAccountGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionTeamGrant` ADD CONSTRAINT `PluginCollectionTeamGrant_rowDbId_fkey` FOREIGN KEY (`rowDbId`) REFERENCES `PluginCollectionRow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionTeamGrant` ADD CONSTRAINT `PluginCollectionTeamGrant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionTeamGrant` ADD CONSTRAINT `PluginCollectionTeamGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionGroupGrant` ADD CONSTRAINT `PluginCollectionGroupGrant_rowDbId_fkey` FOREIGN KEY (`rowDbId`) REFERENCES `PluginCollectionRow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionGroupGrant` ADD CONSTRAINT `PluginCollectionGroupGrant_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionGroupGrant` ADD CONSTRAINT `PluginCollectionGroupGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionKeyEnvelope` ADD CONSTRAINT `PluginCollectionKeyEnvelope_rowDbId_fkey` FOREIGN KEY (`rowDbId`) REFERENCES `PluginCollectionRow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PluginCollectionKeyEnvelope` ADD CONSTRAINT `PluginCollectionKeyEnvelope_recipientAccountId_fkey` FOREIGN KEY (`recipientAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

