ALTER TABLE `ManagedMachine`
    MODIFY `controllerMachineId` VARCHAR(191) NULL,
    MODIFY `controllerInstallationId` VARCHAR(191) NULL,
    ADD CONSTRAINT `ManagedMachine_controller_pair_check`
        CHECK ((`controllerMachineId` IS NULL) = (`controllerInstallationId` IS NULL));
