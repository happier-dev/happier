-- Retain exact source receipt provenance without changing existing receipt data.
ALTER TABLE `Deployment` ADD COLUMN `promotedFromDeploymentId` VARCHAR(191) NULL;
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_promotedFromDeploymentId_fkey`
    FOREIGN KEY (`promotedFromDeploymentId`) REFERENCES `Deployment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
