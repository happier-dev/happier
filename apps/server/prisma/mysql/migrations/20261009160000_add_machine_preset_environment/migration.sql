ALTER TABLE `ManagedMachinePreset` ADD COLUMN `environment` JSON;
ALTER TABLE `ManagedMachine` ADD COLUMN `environmentSetup` JSON;
