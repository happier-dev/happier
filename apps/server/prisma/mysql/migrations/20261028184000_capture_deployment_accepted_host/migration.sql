-- Identity snapshots only: historical receipts neither acquire authority nor retain Machine foreign keys.
ALTER TABLE `Deployment`
    ADD COLUMN `acceptedControllerMachineId` VARCHAR(191) NULL,
    ADD COLUMN `acceptedControllerInstallationId` VARCHAR(191) NULL,
    ADD COLUMN `acceptedBuildMachineId` VARCHAR(191) NULL,
    ADD COLUMN `acceptedBuildInstallationId` VARCHAR(191) NULL;
CREATE INDEX `Deployment_acceptedControllerMachineId_state_id_idx` ON `Deployment`(`acceptedControllerMachineId`, `state`, `id`);
CREATE INDEX `Deployment_acceptedBuildMachineId_state_id_idx` ON `Deployment`(`acceptedBuildMachineId`, `state`, `id`);
