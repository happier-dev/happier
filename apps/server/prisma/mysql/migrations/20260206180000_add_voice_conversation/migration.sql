-- CreateTable
CREATE TABLE `VoiceConversation` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `leaseId` VARCHAR(191) NULL,
    `providerId` VARCHAR(191) NOT NULL,
    `providerConversationId` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `endedAt` DATETIME(3) NULL,
    `durationSeconds` INTEGER NOT NULL,
    `billedUnits` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `VoiceConversation_leaseId_key`(`leaseId`),
    UNIQUE INDEX `VoiceConversation_providerId_providerConversationId_key`(`providerId`, `providerConversationId`),
    INDEX `VoiceConversation_accountId_createdAt_idx`(`accountId`, `createdAt`),
    INDEX `VoiceConversation_accountId_providerId_createdAt_idx`(`accountId`, `providerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VoiceConversation` ADD CONSTRAINT `VoiceConversation_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VoiceConversation` ADD CONSTRAINT `VoiceConversation_leaseId_fkey` FOREIGN KEY (`leaseId`) REFERENCES `VoiceSessionLease`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

