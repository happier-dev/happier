-- Add the Account Service's directory metadata and Home-side issuer links.
ALTER TABLE `Account` ADD COLUMN `preferredHomeServerIdentityId` VARCHAR(191) NULL;

CREATE TABLE `AccountHomeDirectoryEntry` (
    `accountId` VARCHAR(191) NOT NULL,
    `homeServerIdentityId` VARCHAR(191) NOT NULL,
    `canonicalServerUrl` VARCHAR(512) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `connectionDescriptor` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AccountHomeDirectoryEntry_accountId_updatedAt_idx`(`accountId`, `updatedAt`),
    PRIMARY KEY (`accountId`, `homeServerIdentityId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AccountHomeDirectoryEntry`
ADD CONSTRAINT `AccountHomeDirectoryEntry_accountId_fkey`
FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `AccountDirectoryLink` (
    `accountId` VARCHAR(191) NOT NULL,
    `issuerServerIdentityId` VARCHAR(191) NOT NULL,
    `issuerSubjectId` VARCHAR(191) NOT NULL,
    `issuerSigningKeyId` VARCHAR(191) NOT NULL,
    `issuerSigningPublicKey` LONGBLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AccountDirectoryLink_accountId_idx`(`accountId`),
    UNIQUE INDEX `AccountDirectoryLink_accountId_issuerServerIdentityId_key`(`accountId`, `issuerServerIdentityId`),
    PRIMARY KEY (`issuerServerIdentityId`, `issuerSubjectId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AccountDirectoryLink`
ADD CONSTRAINT `AccountDirectoryLink_accountId_fkey`
FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
