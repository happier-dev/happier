ALTER TABLE `Automation` ADD COLUMN `deploymentPreviewRole` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL;
ALTER TABLE `Automation` ADD CONSTRAINT `Automation_deploymentPreviewRole_check`
    CHECK (`deploymentPreviewRole` IS NULL OR `deploymentPreviewRole` IN ('preview_admission', 'preview_cleanup'));

ALTER TABLE `DeploymentEnvironment` ADD COLUMN `previewTemplateEnvironmentId` VARCHAR(191) NULL;
ALTER TABLE `DeploymentEnvironment` ADD COLUMN `previewRepositoryId` VARCHAR(191) NULL;
ALTER TABLE `DeploymentEnvironment` ADD COLUMN `previewPullRequestId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL;
ALTER TABLE `DeploymentEnvironment` ADD COLUMN `previewTargetLinkId` VARCHAR(191) NULL;
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_previewTemplateEnvironmentId_fkey`
    FOREIGN KEY (`previewTemplateEnvironmentId`) REFERENCES `DeploymentEnvironment`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_previewRepositoryId_fkey`
    FOREIGN KEY (`previewRepositoryId`) REFERENCES `ProjectSource`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_previewTargetLinkId_fkey`
    FOREIGN KEY (`previewTargetLinkId`) REFERENCES `DeploymentTargetLink`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_preview_relation_check` CHECK (
    (`purpose` = 'standard' AND `previewTemplateEnvironmentId` IS NULL AND `previewRepositoryId` IS NULL
        AND `previewPullRequestId` IS NULL AND `previewTargetLinkId` IS NULL)
    OR (`purpose` = 'preview' AND `previewTemplateEnvironmentId` IS NOT NULL AND `previewRepositoryId` IS NOT NULL
        AND `previewPullRequestId` IS NOT NULL AND `previewTargetLinkId` IS NOT NULL)
);
-- Functional keys provide the partial live-row uniqueness without persisted lifecycle state.
CREATE UNIQUE INDEX `DeploymentEnvironment_preview_live_key` ON `DeploymentEnvironment` (
    (CASE WHEN `deletedAt` IS NULL THEN `previewTemplateEnvironmentId` ELSE NULL END),
    (CASE WHEN `deletedAt` IS NULL THEN `previewRepositoryId` ELSE NULL END),
    (CASE WHEN `deletedAt` IS NULL THEN `previewPullRequestId` ELSE NULL END),
    (CASE WHEN `deletedAt` IS NULL THEN `previewTargetLinkId` ELSE NULL END)
);
