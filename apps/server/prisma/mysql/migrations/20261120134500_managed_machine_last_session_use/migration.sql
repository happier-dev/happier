ALTER TABLE `ManagedMachine` ADD COLUMN `lastSessionStartedAt` DATETIME(3) NULL;
CREATE INDEX `ManagedMachine_preset_usage_idx` ON `ManagedMachine`(`homeId`, `presetId`, `lastSessionStartedAt`);
