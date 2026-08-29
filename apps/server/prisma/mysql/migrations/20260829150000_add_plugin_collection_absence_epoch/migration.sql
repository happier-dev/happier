CREATE TABLE `PluginCollectionAbsenceEpoch` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `collectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `epoch` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginCollectionAbsenceEpoch_account_collection_key`(`accountId`, `pluginId`, `collectionId`),
    CONSTRAINT `PluginCollectionAbsenceEpoch_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
