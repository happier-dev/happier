-- Add sealed quota snapshot storage for connected services.

CREATE TABLE `ServiceAccountQuotaSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `vendor` VARCHAR(191) NOT NULL,
    `profileId` VARCHAR(191) NOT NULL DEFAULT 'default',
    `snapshot` LONGBLOB NOT NULL,
    `status` VARCHAR(191) NULL,
    `fetchedAt` DATETIME(3) NULL,
    `staleAfterMs` INTEGER NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ServiceAccountQuotaSnapshot_accountId_idx`(`accountId`),
    UNIQUE INDEX `ServiceAccountQuotaSnapshot_accountId_vendor_profileId_key`(`accountId`, `vendor`, `profileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ServiceAccountQuotaSnapshot`
ADD CONSTRAINT `ServiceAccountQuotaSnapshot_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

