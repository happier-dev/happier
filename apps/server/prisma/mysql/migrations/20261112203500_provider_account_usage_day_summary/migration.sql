CREATE TABLE `ProviderAccountUsageDaySummary` (
    `accountId` VARCHAR(191) NOT NULL,
    `recordId` VARCHAR(191) NOT NULL,
    `dayStartAt` DATETIME(3) NOT NULL,
    `payload` JSON NOT NULL,
    INDEX `pauds_day_idx` (`dayStartAt`, `accountId`, `recordId`),
    PRIMARY KEY (`accountId`, `recordId`, `dayStartAt`),
    CONSTRAINT `ProviderAccountUsageDaySummary_accountId_recordId_fkey` FOREIGN KEY (`accountId`, `recordId`) REFERENCES `ProviderAccountUsageRecord` (`accountId`, `recordId`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
