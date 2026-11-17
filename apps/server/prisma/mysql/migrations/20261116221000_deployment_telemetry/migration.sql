ALTER TABLE `DeploymentEnvironment` ADD COLUMN `telemetryMachineId` VARCHAR(191) NULL,
ADD COLUMN `telemetryTokenHash` VARCHAR(191) NULL;

CREATE INDEX `DeploymentEnvironment_telemetryMachineId_deletedAt_id_idx` ON `DeploymentEnvironment`(`telemetryMachineId`, `deletedAt`, `id`);

ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_telemetryMachineId_fkey` FOREIGN KEY (`telemetryMachineId`) REFERENCES `Machine`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
