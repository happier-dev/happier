CREATE TABLE `SessionPin` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `sortKey` VARCHAR(191) NULL,
    `pinnedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionPin_accountId_sessionId_key`(`accountId`, `sessionId`),
    INDEX `SessionPin_accountId_sortKey_idx`(`accountId`, `sortKey`),
    INDEX `SessionPin_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SessionOrganizationFolder` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `folderKey` LONGTEXT NOT NULL,
    `folderHash` VARCHAR(71) NOT NULL,
    `parentKey` LONGTEXT NULL,
    `parentHash` VARCHAR(71) NULL,
    `sortKey` VARCHAR(191) NULL,
    `displayDbValue` LONGTEXT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionOrganizationFolder_accountId_folderHash_key`(`accountId`, `folderHash`),
    INDEX `SessionOrganizationFolder_accountId_parentHash_sortKey_idx`(`accountId`, `parentHash`, `sortKey`),
    INDEX `SessionOrganizationFolder_accountId_archivedAt_idx`(`accountId`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SessionOrganizationTag` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `tagKey` LONGTEXT NOT NULL,
    `tagHash` VARCHAR(71) NOT NULL,
    `sortKey` VARCHAR(191) NULL,
    `displayDbValue` LONGTEXT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionOrganizationTag_accountId_tagHash_key`(`accountId`, `tagHash`),
    INDEX `SessionOrganizationTag_accountId_sortKey_idx`(`accountId`, `sortKey`),
    INDEX `SessionOrganizationTag_accountId_archivedAt_idx`(`accountId`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SessionTagAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `tagId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionTagAssignment_accountId_sessionId_tagId_key`(`accountId`, `sessionId`, `tagId`),
    INDEX `SessionTagAssignment_accountId_tagId_idx`(`accountId`, `tagId`),
    INDEX `SessionTagAssignment_sessionId_idx`(`sessionId`),
    INDEX `SessionTagAssignment_tagId_idx`(`tagId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SessionOrganizationOrderEntry` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `scopeKind` VARCHAR(32) NOT NULL,
    `scopeKey` LONGTEXT NOT NULL,
    `scopeHash` VARCHAR(71) NOT NULL,
    `itemKind` VARCHAR(32) NOT NULL,
    `itemKey` LONGTEXT NOT NULL,
    `itemHash` VARCHAR(71) NOT NULL,
    `sortKey` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionOrgOrderEntry_scope_item_key`(`accountId`, `scopeKind`, `scopeHash`, `itemKind`, `itemHash`),
    INDEX `SessionOrgOrderEntry_scope_sort_idx`(`accountId`, `scopeKind`, `scopeHash`, `sortKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SessionOrganizationLabel` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `labelKind` VARCHAR(32) NOT NULL,
    `scopeKey` LONGTEXT NOT NULL,
    `scopeHash` VARCHAR(71) NOT NULL,
    `displayDbValue` LONGTEXT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionOrganizationLabel_accountId_labelKind_scopeHash_key`(`accountId`, `labelKind`, `scopeHash`),
    INDEX `SessionOrganizationLabel_accountId_labelKind_archivedAt_idx`(`accountId`, `labelKind`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SessionOrganizationCheckpoint` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SessionOrganizationCheckpoint_accountId_key`(`accountId`),
    INDEX `SessionOrganizationCheckpoint_accountId_version_idx`(`accountId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SessionPin`
ADD CONSTRAINT `SessionPin_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionPin`
ADD CONSTRAINT `SessionPin_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionOrganizationFolder`
ADD CONSTRAINT `SessionOrganizationFolder_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionOrganizationTag`
ADD CONSTRAINT `SessionOrganizationTag_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionTagAssignment`
ADD CONSTRAINT `SessionTagAssignment_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionTagAssignment`
ADD CONSTRAINT `SessionTagAssignment_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionTagAssignment`
ADD CONSTRAINT `SessionTagAssignment_tagId_fkey` FOREIGN KEY (`tagId`) REFERENCES `SessionOrganizationTag`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionOrganizationOrderEntry`
ADD CONSTRAINT `SessionOrganizationOrderEntry_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionOrganizationLabel`
ADD CONSTRAINT `SessionOrganizationLabel_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionOrganizationCheckpoint`
ADD CONSTRAINT `SessionOrganizationCheckpoint_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
