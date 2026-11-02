-- Additive identity widening. Existing host runtime rows remain valid.
ALTER TABLE `DeploymentTargetLink`
    MODIFY COLUMN `hostTargetId` VARCHAR(191) NULL,
    ADD COLUMN `pluginId` VARCHAR(191) NULL,
    ADD COLUMN `contributionLocalId` VARCHAR(191) NULL,
    ADD COLUMN `machineId` VARCHAR(191) NULL,
    ADD COLUMN `installationId` VARCHAR(191) NULL;
ALTER TABLE `DeploymentTargetLink` DROP CHECK `DeploymentTargetLink_values_check`;
ALTER TABLE `DeploymentTargetLink` ADD CONSTRAINT `DeploymentTargetLink_values_check` CHECK (
    `revision` >= 1 AND `contentHeaderVersion` >= 1 AND `contentBodyVersion` >= 1
    AND `state` IN ('none', 'configured', 'provisioned', 'deployed')
    AND (
        (`sourceKind` = 'host' AND `role` = 'runtime' AND `targetKind` = 'ownServer'
            AND `hostTargetId` IS NOT NULL
            AND `pluginId` IS NULL AND `contributionLocalId` IS NULL)
        OR (`sourceKind` = 'plugin' AND `role` IN ('runtime', 'data')
            AND `hostTargetId` IS NULL AND LENGTH(TRIM(`targetKind`)) > 0
            AND `pluginId` IS NOT NULL AND LENGTH(TRIM(`pluginId`)) > 0
            AND `contributionLocalId` IS NOT NULL AND LENGTH(TRIM(`contributionLocalId`)) > 0)
    )
);
ALTER TABLE `DeploymentTargetLink` ADD CONSTRAINT `DeploymentTargetLink_machineId_fkey`
    FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX `DeploymentTargetLink_machineId_deletedAt_id_idx` ON `DeploymentTargetLink`(`machineId`, `deletedAt`, `id`);
CREATE INDEX `DeploymentTargetLink_pluginId_contributionLocalId_idx` ON `DeploymentTargetLink`(`pluginId`, `contributionLocalId`);
