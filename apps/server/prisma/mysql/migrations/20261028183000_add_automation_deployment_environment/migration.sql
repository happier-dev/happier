ALTER TABLE `Automation` ADD COLUMN `deploymentEnvironmentId` VARCHAR(191) NULL;
ALTER TABLE `Automation` ADD CONSTRAINT `Automation_deploymentEnvironmentId_fkey`
    FOREIGN KEY (`deploymentEnvironmentId`) REFERENCES `DeploymentEnvironment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX `Automation_deploymentEnvironmentId_deletedAt_id_idx` ON `Automation`(`deploymentEnvironmentId`, `deletedAt`, `id`);
