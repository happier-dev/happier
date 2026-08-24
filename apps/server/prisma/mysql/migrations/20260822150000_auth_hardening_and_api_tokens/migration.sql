-- CreateTable
CREATE TABLE `KeyChallengeV2` (
    `id` VARCHAR(191) NOT NULL,
    `nonce` VARCHAR(191) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `audienceOrigin` VARCHAR(191) NOT NULL,
    `audienceServerIdentityId` VARCHAR(191) NULL,
    `expectedAccountId` VARCHAR(191) NULL,
    `consumedAt` DATETIME(3) NULL,

    INDEX `KeyChallengeV2_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `Account` ADD COLUMN `tokenEpoch` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `AccountApiToken` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `displayPrefix` VARCHAR(191) NOT NULL,
    `secretDigest` VARCHAR(191) NOT NULL,
    `label` VARCHAR(256) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,

    INDEX `AccountApiToken_accountId_createdAt_idx`(`accountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AccountApiToken` ADD CONSTRAINT `AccountApiToken_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
