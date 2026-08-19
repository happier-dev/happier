-- CreateTable
CREATE TABLE `SessionAttentionStanding` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `standing` BOOLEAN NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SessionAttentionStanding_accountId_standing_idx`(`accountId`, `standing`),
    INDEX `SessionAttentionStanding_sessionId_idx`(`sessionId`),
    UNIQUE INDEX `SessionAttentionStanding_accountId_sessionId_key`(`accountId`, `sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SessionAttentionStanding` ADD CONSTRAINT `SessionAttentionStanding_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SessionAttentionStanding` ADD CONSTRAINT `SessionAttentionStanding_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
