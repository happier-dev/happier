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
