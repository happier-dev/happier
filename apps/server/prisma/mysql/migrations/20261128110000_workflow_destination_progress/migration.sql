CREATE TABLE `WorkflowRunDestination` (
    `rootRecordId` VARCHAR(191) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `contentEnvelope` LONGTEXT NOT NULL,
    PRIMARY KEY (`rootRecordId`, `ordinal`),
    CONSTRAINT `WorkflowRunDestination_rootRecordId_fkey` FOREIGN KEY (`rootRecordId`) REFERENCES `WorkflowRunInvocation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
