ALTER TABLE `DeploymentEnvironment` ADD COLUMN `telemetryPendingTokenHash` VARCHAR(191) NULL;
ALTER TABLE `DeploymentEnvironment` ADD COLUMN `telemetryPendingTargetLinkId` VARCHAR(191) NULL;
ALTER TABLE `DeploymentEnvironment` ADD COLUMN `telemetryPendingTargetLinkRevision` INTEGER NULL;
