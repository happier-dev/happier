-- CreateTable
CREATE TABLE `Account` (
    `id` VARCHAR(191) NOT NULL,
    `publicKey` VARCHAR(191) NOT NULL,
    `contentPublicKey` LONGBLOB NULL,
    `contentPublicKeySig` LONGBLOB NULL,
    `seq` INTEGER NOT NULL DEFAULT 0,
    `changesFloor` INTEGER NOT NULL DEFAULT 0,
    `feedSeq` BIGINT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `settings` VARCHAR(191) NULL,
    `settingsVersion` INTEGER NOT NULL DEFAULT 0,
    `githubUserId` VARCHAR(191) NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `username` VARCHAR(191) NULL,
    `avatar` JSON NULL,

    UNIQUE INDEX `Account_publicKey_key`(`publicKey`),
    UNIQUE INDEX `Account_githubUserId_key`(`githubUserId`),
    UNIQUE INDEX `Account_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccountChange` (
    `accountId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `cursor` INTEGER NOT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `hint` JSON NULL,
    `sessionId` VARCHAR(191) NULL,
    `machineId` VARCHAR(191) NULL,
    `artifactId` VARCHAR(191) NULL,

    INDEX `AccountChange_accountId_cursor_idx`(`accountId`, `cursor`),
    PRIMARY KEY (`accountId`, `kind`, `entityId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TerminalAuthRequest` (
    `id` VARCHAR(191) NOT NULL,
    `publicKey` VARCHAR(191) NOT NULL,
    `supportsV2` BOOLEAN NOT NULL DEFAULT false,
    `response` VARCHAR(191) NULL,
    `responseAccountId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TerminalAuthRequest_publicKey_key`(`publicKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccountAuthRequest` (
    `id` VARCHAR(191) NOT NULL,
    `publicKey` VARCHAR(191) NOT NULL,
    `response` VARCHAR(191) NULL,
    `responseAccountId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AccountAuthRequest_publicKey_key`(`publicKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccountPushToken` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AccountPushToken_accountId_token_key`(`accountId`, `token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `tag` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `metadata` VARCHAR(191) NOT NULL,
    `metadataVersion` INTEGER NOT NULL DEFAULT 0,
    `agentState` VARCHAR(191) NULL,
    `agentStateVersion` INTEGER NOT NULL DEFAULT 0,
    `dataEncryptionKey` LONGBLOB NULL,
    `seq` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `lastActiveAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Session_accountId_updatedAt_idx`(`accountId`, `updatedAt`),
    UNIQUE INDEX `Session_accountId_tag_key`(`accountId`, `tag`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SessionMessage` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `localId` VARCHAR(191) NULL,
    `seq` INTEGER NOT NULL,
    `content` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SessionMessage_sessionId_seq_idx`(`sessionId`, `seq`),
    UNIQUE INDEX `SessionMessage_sessionId_localId_key`(`sessionId`, `localId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GithubUser` (
    `id` VARCHAR(191) NOT NULL,
    `profile` JSON NOT NULL,
    `token` LONGBLOB NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GithubOrganization` (
    `id` VARCHAR(191) NOT NULL,
    `profile` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GlobalLock` (
    `key` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RepeatKey` (
    `key` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SimpleCache` (
    `key` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UsageReport` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `data` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UsageReport_accountId_idx`(`accountId`),
    INDEX `UsageReport_sessionId_idx`(`sessionId`),
    UNIQUE INDEX `UsageReport_accountId_sessionId_key_key`(`accountId`, `sessionId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Machine` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `metadata` VARCHAR(191) NOT NULL,
    `metadataVersion` INTEGER NOT NULL DEFAULT 0,
    `daemonState` VARCHAR(191) NULL,
    `daemonStateVersion` INTEGER NOT NULL DEFAULT 0,
    `dataEncryptionKey` LONGBLOB NULL,
    `seq` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `lastActiveAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Machine_accountId_idx`(`accountId`),
    UNIQUE INDEX `Machine_accountId_id_key`(`accountId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UploadedFile` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `thumbhash` VARCHAR(191) NULL,
    `reuseKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UploadedFile_accountId_idx`(`accountId`),
    UNIQUE INDEX `UploadedFile_accountId_path_key`(`accountId`, `path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ServiceAccountToken` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `vendor` VARCHAR(191) NOT NULL,
    `token` LONGBLOB NOT NULL,
    `metadata` JSON NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ServiceAccountToken_accountId_idx`(`accountId`),
    UNIQUE INDEX `ServiceAccountToken_accountId_vendor_key`(`accountId`, `vendor`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Artifact` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `header` LONGBLOB NOT NULL,
    `headerVersion` INTEGER NOT NULL DEFAULT 0,
    `body` LONGBLOB NOT NULL,
    `bodyVersion` INTEGER NOT NULL DEFAULT 0,
    `dataEncryptionKey` LONGBLOB NOT NULL,
    `seq` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Artifact_accountId_idx`(`accountId`),
    INDEX `Artifact_accountId_updatedAt_idx`(`accountId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccessKey` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `data` VARCHAR(191) NOT NULL,
    `dataVersion` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AccessKey_accountId_idx`(`accountId`),
    INDEX `AccessKey_sessionId_idx`(`sessionId`),
    INDEX `AccessKey_machineId_idx`(`machineId`),
    UNIQUE INDEX `AccessKey_accountId_machineId_sessionId_key`(`accountId`, `machineId`, `sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserRelationship` (
    `fromUserId` VARCHAR(191) NOT NULL,
    `toUserId` VARCHAR(191) NOT NULL,
    `status` ENUM('none', 'requested', 'pending', 'friend', 'rejected') NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `lastNotifiedAt` DATETIME(3) NULL,

    INDEX `UserRelationship_toUserId_status_idx`(`toUserId`, `status`),
    INDEX `UserRelationship_fromUserId_status_idx`(`fromUserId`, `status`),
    PRIMARY KEY (`fromUserId`, `toUserId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserFeedItem` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `counter` BIGINT NOT NULL,
    `repeatKey` VARCHAR(191) NULL,
    `body` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserFeedItem_userId_counter_idx`(`userId`, `counter`),
    UNIQUE INDEX `UserFeedItem_userId_counter_key`(`userId`, `counter`),
    UNIQUE INDEX `UserFeedItem_userId_repeatKey_key`(`userId`, `repeatKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserKVStore` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `value` LONGBLOB NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserKVStore_accountId_idx`(`accountId`),
    UNIQUE INDEX `UserKVStore_accountId_key_key`(`accountId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SessionShare` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `sharedByUserId` VARCHAR(191) NOT NULL,
    `sharedWithUserId` VARCHAR(191) NOT NULL,
    `accessLevel` ENUM('view', 'edit', 'admin') NOT NULL DEFAULT 'view',
    `canApprovePermissions` BOOLEAN NOT NULL DEFAULT false,
    `encryptedDataKey` LONGBLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SessionShare_sharedWithUserId_idx`(`sharedWithUserId`),
    INDEX `SessionShare_sharedByUserId_idx`(`sharedByUserId`),
    INDEX `SessionShare_sessionId_idx`(`sessionId`),
    UNIQUE INDEX `SessionShare_sessionId_sharedWithUserId_key`(`sessionId`, `sharedWithUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SessionShareAccessLog` (
    `id` VARCHAR(191) NOT NULL,
    `sessionShareId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `accessedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` VARCHAR(191) NULL,

    INDEX `SessionShareAccessLog_sessionShareId_idx`(`sessionShareId`),
    INDEX `SessionShareAccessLog_userId_idx`(`userId`),
    INDEX `SessionShareAccessLog_accessedAt_idx`(`accessedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PublicSessionShare` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `createdByUserId` VARCHAR(191) NOT NULL,
    `tokenHash` LONGBLOB NOT NULL,
    `encryptedDataKey` LONGBLOB NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `maxUses` INTEGER NULL,
    `useCount` INTEGER NOT NULL DEFAULT 0,
    `isConsentRequired` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PublicSessionShare_sessionId_key`(`sessionId`),
    UNIQUE INDEX `PublicSessionShare_tokenHash_key`(`tokenHash`),
    INDEX `PublicSessionShare_tokenHash_idx`(`tokenHash`),
    INDEX `PublicSessionShare_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PublicShareAccessLog` (
    `id` VARCHAR(191) NOT NULL,
    `publicShareId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `accessedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` VARCHAR(191) NULL,

    INDEX `PublicShareAccessLog_publicShareId_idx`(`publicShareId`),
    INDEX `PublicShareAccessLog_userId_idx`(`userId`),
    INDEX `PublicShareAccessLog_accessedAt_idx`(`accessedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PublicShareBlockedUser` (
    `id` VARCHAR(191) NOT NULL,
    `publicShareId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `blockedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reason` VARCHAR(191) NULL,

    INDEX `PublicShareBlockedUser_publicShareId_idx`(`publicShareId`),
    INDEX `PublicShareBlockedUser_userId_idx`(`userId`),
    UNIQUE INDEX `PublicShareBlockedUser_publicShareId_userId_key`(`publicShareId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Account` ADD CONSTRAINT `Account_githubUserId_fkey` FOREIGN KEY (`githubUserId`) REFERENCES `GithubUser`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountChange` ADD CONSTRAINT `AccountChange_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountChange` ADD CONSTRAINT `AccountChange_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountChange` ADD CONSTRAINT `AccountChange_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `Artifact`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountChange` ADD CONSTRAINT `AccountChange_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TerminalAuthRequest` ADD CONSTRAINT `TerminalAuthRequest_responseAccountId_fkey` FOREIGN KEY (`responseAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountAuthRequest` ADD CONSTRAINT `AccountAuthRequest_responseAccountId_fkey` FOREIGN KEY (`responseAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountPushToken` ADD CONSTRAINT `AccountPushToken_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SessionMessage` ADD CONSTRAINT `SessionMessage_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UsageReport` ADD CONSTRAINT `UsageReport_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UsageReport` ADD CONSTRAINT `UsageReport_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Machine` ADD CONSTRAINT `Machine_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UploadedFile` ADD CONSTRAINT `UploadedFile_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ServiceAccountToken` ADD CONSTRAINT `ServiceAccountToken_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Artifact` ADD CONSTRAINT `Artifact_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccessKey` ADD CONSTRAINT `AccessKey_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccessKey` ADD CONSTRAINT `AccessKey_accountId_machineId_fkey` FOREIGN KEY (`accountId`, `machineId`) REFERENCES `Machine`(`accountId`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccessKey` ADD CONSTRAINT `AccessKey_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserRelationship` ADD CONSTRAINT `UserRelationship_fromUserId_fkey` FOREIGN KEY (`fromUserId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserRelationship` ADD CONSTRAINT `UserRelationship_toUserId_fkey` FOREIGN KEY (`toUserId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserFeedItem` ADD CONSTRAINT `UserFeedItem_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserKVStore` ADD CONSTRAINT `UserKVStore_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SessionShare` ADD CONSTRAINT `SessionShare_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SessionShare` ADD CONSTRAINT `SessionShare_sharedByUserId_fkey` FOREIGN KEY (`sharedByUserId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SessionShare` ADD CONSTRAINT `SessionShare_sharedWithUserId_fkey` FOREIGN KEY (`sharedWithUserId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SessionShareAccessLog` ADD CONSTRAINT `SessionShareAccessLog_sessionShareId_fkey` FOREIGN KEY (`sessionShareId`) REFERENCES `SessionShare`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SessionShareAccessLog` ADD CONSTRAINT `SessionShareAccessLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicSessionShare` ADD CONSTRAINT `PublicSessionShare_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicSessionShare` ADD CONSTRAINT `PublicSessionShare_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicShareAccessLog` ADD CONSTRAINT `PublicShareAccessLog_publicShareId_fkey` FOREIGN KEY (`publicShareId`) REFERENCES `PublicSessionShare`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicShareAccessLog` ADD CONSTRAINT `PublicShareAccessLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicShareBlockedUser` ADD CONSTRAINT `PublicShareBlockedUser_publicShareId_fkey` FOREIGN KEY (`publicShareId`) REFERENCES `PublicSessionShare`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicShareBlockedUser` ADD CONSTRAINT `PublicShareBlockedUser_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
