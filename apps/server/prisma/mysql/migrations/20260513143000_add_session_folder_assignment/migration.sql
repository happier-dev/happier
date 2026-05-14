CREATE TABLE `SessionFolderAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `folderId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `SessionFolderAssignment_accountId_sessionId_key` ON `SessionFolderAssignment`(`accountId`, `sessionId`);
CREATE INDEX `SessionFolderAssignment_accountId_folderId_updatedAt_idx` ON `SessionFolderAssignment`(`accountId`, `folderId`, `updatedAt`);
CREATE INDEX `SessionFolderAssignment_sessionId_idx` ON `SessionFolderAssignment`(`sessionId`);

ALTER TABLE `SessionFolderAssignment` ADD CONSTRAINT `SessionFolderAssignment_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SessionFolderAssignment` ADD CONSTRAINT `SessionFolderAssignment_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
