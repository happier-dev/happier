-- AlterTable
ALTER TABLE `Session` ADD COLUMN `pendingVersion` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `Session` ADD COLUMN `pendingCount` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `SessionPendingMessage` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `authorAccountId` VARCHAR(191) NULL,
    `localId` VARCHAR(191) NOT NULL,
    `content` JSON NOT NULL,
    `status` ENUM('queued', 'discarded') NOT NULL DEFAULT 'queued',
    `position` INTEGER NOT NULL,
    `discardedAt` DATETIME(3) NULL,
    `discardedReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionPendingMessage_sessionId_localId_key`(`sessionId`, `localId`),
    INDEX `SessionPendingMessage_sessionId_status_position_idx`(`sessionId`, `status`, `position`),
    INDEX `SessionPendingMessage_sessionId_authorAccountId_idx`(`sessionId`, `authorAccountId`),
    INDEX `SessionPendingMessage_sessionId_status_updatedAt_idx`(`sessionId`, `status`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SessionPendingMessage` ADD CONSTRAINT `SessionPendingMessage_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SessionPendingMessage` ADD CONSTRAINT `SessionPendingMessage_authorAccountId_fkey` FOREIGN KEY (`authorAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

