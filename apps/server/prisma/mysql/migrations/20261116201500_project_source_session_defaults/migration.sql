CREATE TABLE `ProjectSourceSessionDefaults` (
    `sourceId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `defaults` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`sourceId`),
    CONSTRAINT `ProjectSourceSessionDefaults_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `ProjectSource`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
