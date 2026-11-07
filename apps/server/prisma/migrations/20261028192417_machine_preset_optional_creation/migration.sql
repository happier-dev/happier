ALTER TABLE "ManagedMachinePreset"
    ALTER COLUMN "launch" DROP NOT NULL,
    ALTER COLUMN "controllerMachineId" DROP NOT NULL,
    ALTER COLUMN "controllerInstallationId" DROP NOT NULL;
