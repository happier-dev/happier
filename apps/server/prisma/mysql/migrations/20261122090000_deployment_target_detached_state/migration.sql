-- A recorded detach releases Happier custody while retaining historical references.
ALTER TABLE `DeploymentTargetLink` DROP CHECK `DeploymentTargetLink_values_check`,
    ADD CONSTRAINT `DeploymentTargetLink_values_check` CHECK (
    `revision` >= 1 AND `contentHeaderVersion` >= 1 AND `contentBodyVersion` >= 1
    AND `state` IN ('none', 'configured', 'provisioned', 'deployed', 'detached')
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
