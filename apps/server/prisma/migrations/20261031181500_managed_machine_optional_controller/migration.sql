ALTER TABLE "ManagedMachine"
    ALTER COLUMN "controllerMachineId" DROP NOT NULL,
    ALTER COLUMN "controllerInstallationId" DROP NOT NULL,
    ADD CONSTRAINT "ManagedMachine_controller_pair_check"
        CHECK (("controllerMachineId" IS NULL) = ("controllerInstallationId" IS NULL));
