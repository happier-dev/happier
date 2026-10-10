CREATE TABLE `ProviderAccountUsageHistory` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `recordId` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `payload` JSON NOT NULL,
    INDEX `pauh_record_time_idx` (`accountId`, `recordId`, `observedAt`, `id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `ProviderAccountUsageHistory_accountId_recordId_fkey` FOREIGN KEY (`accountId`, `recordId`) REFERENCES `ProviderAccountUsageRecord` (`accountId`, `recordId`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
