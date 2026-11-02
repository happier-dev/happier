-- Replaced links retain their workload custody and receipt lineage.
ALTER TABLE `DeploymentTargetLink` ADD COLUMN `predecessorTargetLinkId` VARCHAR(191) NULL;
ALTER TABLE `DeploymentTargetLink` ADD CONSTRAINT `DeploymentTargetLink_predecessorTargetLinkId_fkey`
    FOREIGN KEY (`predecessorTargetLinkId`) REFERENCES `DeploymentTargetLink`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
