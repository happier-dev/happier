CREATE TABLE `ProjectDeploymentDefaults` (
    `projectSourceId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `contentArtifactId` VARCHAR(191) NULL,
    `contentHeaderVersion` INTEGER NULL,
    `contentBodyVersion` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`projectSourceId`),
    INDEX `ProjectDeploymentDefaults_contentArtifactId_idx` (`contentArtifactId`),
    CONSTRAINT `ProjectDeploymentDefaults_content_check` CHECK (
        (`contentHeaderVersion` IS NULL AND `contentBodyVersion` IS NULL)
        OR (`contentHeaderVersion` IS NOT NULL AND `contentBodyVersion` IS NOT NULL
            AND `contentHeaderVersion` > 0 AND `contentBodyVersion` > 0)
    ),
    CONSTRAINT `ProjectDeploymentDefaults_projectSourceId_fkey` FOREIGN KEY (`projectSourceId`) REFERENCES `ProjectSource`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ProjectDeploymentDefaults_contentArtifactId_fkey` FOREIGN KEY (`contentArtifactId`) REFERENCES `Artifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
