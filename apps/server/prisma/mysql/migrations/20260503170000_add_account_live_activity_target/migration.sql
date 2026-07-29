-- CreateTable
CREATE TABLE `AccountLiveActivityTarget` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `serverId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `activityInstanceKey` VARCHAR(191) NOT NULL,
    `activityId` VARCHAR(191) NOT NULL,
    `activityName` VARCHAR(191) NOT NULL,
    `targetIdentityHash` VARCHAR(191) NOT NULL,
    `transportMode` VARCHAR(191) NOT NULL,
    `bundleId` VARCHAR(191) NULL,
    `environment` VARCHAR(191) NULL,
    `tokenKind` VARCHAR(191) NOT NULL,
    `rawTokenEncrypted` LONGBLOB NULL,
    `expoPushToken` VARCHAR(191) NULL,
    `clientServerUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `lastPushedAt` DATETIME(3) NULL,
    `lastPayloadHash` VARCHAR(191) NULL,
    `failureCount` INTEGER NOT NULL DEFAULT 0,
    `lastFailureCode` VARCHAR(191) NULL,
    `diagnostics` JSON NULL,

    UNIQUE INDEX `AccountLiveActivityTarget_accountId_targetIdentityHash_key`(`accountId`, `targetIdentityHash`),
    INDEX `AccountLiveActivityTarget_lookup_active_idx`(`accountId`, `serverId`, `sessionId`, `activityName`, `endedAt`),
    INDEX `AccountLiveActivityTarget_accountId_transportMode_endedAt_idx`(`accountId`, `transportMode`, `endedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AccountLiveActivityTarget` ADD CONSTRAINT `AccountLiveActivityTarget_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
