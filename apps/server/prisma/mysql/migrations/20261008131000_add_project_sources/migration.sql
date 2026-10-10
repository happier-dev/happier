CREATE TABLE `ProjectSource` (
    `id` VARCHAR(191) NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `name` TEXT NOT NULL,
    `repository` JSON NOT NULL,
    `defaultRef` TEXT NULL,
    `subdir` TEXT NULL,
    `audience` JSON NOT NULL,
    `attachments` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `ProjectSource_createdByAccountId_id_idx` (`createdByAccountId`, `id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `ProjectSource_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
