CREATE TABLE `ReviewMetadata` (
    `artifactId` VARCHAR(191) NOT NULL,
    `projectSourceId` VARCHAR(191) NULL,
    `workflowId` VARCHAR(191) NULL,
    `subjectKind` VARCHAR(191) NOT NULL,
    `sourceKind` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `currentRoundOrdinal` INTEGER NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NULL,
    PRIMARY KEY (`artifactId`),
    INDEX `ReviewMetadata_projectSourceId_state_artifactId_idx` (`projectSourceId`, `state`, `artifactId`),
    INDEX `ReviewMetadata_workflowId_startedAt_artifactId_idx` (`workflowId`, `startedAt` DESC, `artifactId`),
    INDEX `ReviewMetadata_state_startedAt_artifactId_idx` (`state`, `startedAt` DESC, `artifactId`),
    CONSTRAINT `ReviewMetadata_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `Artifact` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
