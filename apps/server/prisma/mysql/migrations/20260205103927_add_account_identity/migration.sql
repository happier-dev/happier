-- CreateTable
CREATE TABLE `AccountIdentity` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `providerUserId` VARCHAR(191) NOT NULL,
    `providerLogin` VARCHAR(191) NULL,
    `profile` JSON NULL,
    `token` LONGBLOB NULL,
    `scopes` VARCHAR(191) NULL,
    `eligibilityStatus` ENUM('unknown', 'eligible', 'ineligible') NOT NULL DEFAULT 'unknown',
    `eligibilityReason` VARCHAR(191) NULL,
    `eligibilityCheckedAt` DATETIME(3) NULL,
    `eligibilityNextCheckAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AccountIdentity_accountId_idx`(`accountId`),
    UNIQUE INDEX `AccountIdentity_provider_providerUserId_key`(`provider`, `providerUserId`),
    UNIQUE INDEX `AccountIdentity_accountId_provider_key`(`accountId`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AccountIdentity` ADD CONSTRAINT `AccountIdentity_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

