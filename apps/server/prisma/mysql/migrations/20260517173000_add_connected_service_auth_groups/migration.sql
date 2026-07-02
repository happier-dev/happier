-- Add connected service account group storage and member mappings.

CREATE TABLE `ConnectedServiceAuthGroup` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `vendor` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NULL,
    `policyJson` LONGTEXT NOT NULL,
    `activeProfileId` VARCHAR(191) NULL,
    `generation` INTEGER NOT NULL DEFAULT 0,
    `stateJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ConnectedServiceAuthGroup_accountId_vendor_idx`(`accountId`, `vendor`),
    UNIQUE INDEX `ConnectedServiceAuthGroup_accountId_vendor_groupId_key`(`accountId`, `vendor`, `groupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ConnectedServiceAuthGroupMember` (
    `id` VARCHAR(191) NOT NULL,
    `groupDbId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `vendor` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NOT NULL,
    `profileId` VARCHAR(191) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `stateJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ConnectedServiceAuthGroupMember_groupDbId_idx`(`groupDbId`),
    INDEX `ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx`(`accountId`, `vendor`, `profileId`),
    UNIQUE INDEX `ConnectedServiceAuthGroupMember_accountId_vendor_groupId_profileId_key`(`accountId`, `vendor`, `groupId`, `profileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ConnectedServiceAuthGroup`
ADD CONSTRAINT `ConnectedServiceAuthGroup_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ConnectedServiceAuthGroupMember`
ADD CONSTRAINT `ConnectedServiceAuthGroupMember_groupDbId_fkey` FOREIGN KEY (`groupDbId`) REFERENCES `ConnectedServiceAuthGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
