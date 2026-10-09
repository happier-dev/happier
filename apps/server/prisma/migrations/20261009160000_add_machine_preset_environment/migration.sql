ALTER TABLE "ManagedMachinePreset" ADD COLUMN "environment" JSONB;
ALTER TABLE "ManagedMachine" ADD COLUMN "environmentSetup" JSONB;
