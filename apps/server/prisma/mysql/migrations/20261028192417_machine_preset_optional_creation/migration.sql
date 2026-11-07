ALTER TABLE `ManagedMachinePreset`
    MODIFY COLUMN `launch` JSON NULL,
    MODIFY COLUMN `controllerMachineId` VARCHAR(191) NULL,
    MODIFY COLUMN `controllerInstallationId` VARCHAR(191) NULL;
