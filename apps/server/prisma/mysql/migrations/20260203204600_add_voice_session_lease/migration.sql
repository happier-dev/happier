-- CreateTable
CREATE TABLE `VoiceSessionLease` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `periodKey` VARCHAR(191) NOT NULL,
    `grantedBy` VARCHAR(191) NOT NULL,
    `elevenLabsAgentId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `VoiceSessionLease_accountId_expiresAt_idx`(`accountId`, `expiresAt`),
    INDEX `VoiceSessionLease_accountId_periodKey_idx`(`accountId`, `periodKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VoiceSessionLease` ADD CONSTRAINT `VoiceSessionLease_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

