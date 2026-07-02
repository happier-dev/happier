CREATE TABLE `AccountSettingsSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `settingsDbValue` LONGTEXT NULL,
    `encryptionMode` VARCHAR(191) NOT NULL,
    `contentKind` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AccountSettingsSnapshot_accountId_version_idx`(`accountId`, `version`),
    INDEX `AccountSettingsSnapshot_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `AccountSettingsSnapshot_accountId_version_key`(`accountId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AccountSettingsSnapshot`
ADD CONSTRAINT `AccountSettingsSnapshot_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
