CREATE TABLE `ResourceSpaceMembership` (
    `accountId` VARCHAR(191) NOT NULL,
    `spaceId` VARCHAR(191) NOT NULL,
    `resourceKind` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`accountId`, `spaceId`, `resourceKind`, `resourceId`),
    INDEX `ResourceSpaceMembership_accountId_resourceKind_resourceId_idx` (`accountId`, `resourceKind`, `resourceId`),
    INDEX `ResourceSpaceMembership_resourceId_idx` (`resourceId`),
    CONSTRAINT `ResourceSpaceMembership_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ResourceSpaceMembership_resourceId_fkey` FOREIGN KEY (`resourceId`) REFERENCES `Artifact` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
