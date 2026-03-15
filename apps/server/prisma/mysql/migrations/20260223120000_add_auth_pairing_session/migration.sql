-- CreateTable
CREATE TABLE `AuthPairingSession` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `secretHash` VARCHAR(191) NOT NULL,
    `requestedPublicKey` VARCHAR(191) NULL,
    `requestedDeviceLabel` VARCHAR(191) NULL,
    `requestedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AuthPairingSession_accountId_expiresAt_idx`(`accountId`, `expiresAt`),
    INDEX `AuthPairingSession_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AuthPairingSession` ADD CONSTRAINT `AuthPairingSession_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
