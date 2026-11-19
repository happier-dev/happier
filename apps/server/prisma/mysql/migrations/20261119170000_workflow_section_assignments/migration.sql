CREATE TABLE `OrganizationFolderAssignment` (
    `accountId` VARCHAR(191) NOT NULL,
    `entityKind` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `folderId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`accountId`, `entityKind`, `entityId`),
    INDEX `OrganizationFolderAssignment_accountId_folderId_idx` (`accountId`, `folderId`),
    INDEX `OrganizationFolderAssignment_folderId_idx` (`folderId`),
    CONSTRAINT `OrganizationFolderAssignment_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `OrganizationFolderAssignment_folderId_fkey` FOREIGN KEY (`folderId`) REFERENCES `SessionOrganizationFolder` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
