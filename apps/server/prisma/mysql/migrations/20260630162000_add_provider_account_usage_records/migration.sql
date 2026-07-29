-- Add dedicated provider-account usage records and connected-service usage sources.

CREATE TABLE `ProviderAccountUsageRecord` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `providerId` VARCHAR(191) NOT NULL,
    `recordId` VARCHAR(191) NOT NULL,
    `accountSubjectId` VARCHAR(191) NOT NULL,
    `subjectKind` VARCHAR(191) NOT NULL,
    `quotaScope` VARCHAR(191) NOT NULL,
    `quotaScopeId` VARCHAR(191) NULL,
    `quotaScopeIdKey` VARCHAR(191) NOT NULL,
    `recordKeyJson` JSON NOT NULL,
    `payloadMode` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `snapshot` JSON NULL,
    `sealedPayload` JSON NULL,
    `fetchedAt` DATETIME(3) NULL,
    `staleAfterMs` INTEGER NULL,
    `refreshRequestedAt` DATETIME(3) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProviderAccountUsageRecord_accountId_recordId_key`(`accountId`, `recordId`),
    INDEX `ProviderAccountUsageRecord_accountId_providerId_idx`(`accountId`, `providerId`),
    INDEX `ProviderAccountUsageRecord_accountId_status_idx`(`accountId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ConnectedServiceUsageSource` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `profileId` VARCHAR(191) NOT NULL,
    `sourceKey` VARCHAR(191) NOT NULL,
    `providerAccountUsageRecordId` VARCHAR(191) NOT NULL,
    `bindingKind` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NULL,
    `groupGeneration` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `csus_account_service_profile_idx`(`accountId`, `serviceId`, `profileId`),
    UNIQUE INDEX `ConnectedServiceUsageSource_accountId_sourceKey_key`(`accountId`, `sourceKey`),
    INDEX `csus_paur_idx`(`accountId`, `providerAccountUsageRecordId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProviderAccountUsageRecord`
ADD CONSTRAINT `ProviderAccountUsageRecord_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ConnectedServiceUsageSource`
ADD CONSTRAINT `csus_paur_fkey`
FOREIGN KEY (`accountId`, `providerAccountUsageRecordId`) REFERENCES `ProviderAccountUsageRecord`(`accountId`, `recordId`) ON DELETE CASCADE ON UPDATE CASCADE;
