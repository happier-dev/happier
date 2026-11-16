-- Additive storage only. Legacy rows remain readable; no backfill.
ALTER TABLE `Session` ADD COLUMN `metadataBytes` LONGBLOB;
ALTER TABLE `Session` ADD COLUMN `agentStateBytes` LONGBLOB;
ALTER TABLE `Machine` ADD COLUMN `metadataBytes` LONGBLOB;
ALTER TABLE `Machine` ADD COLUMN `daemonStateBytes` LONGBLOB;
ALTER TABLE `SessionSystemRecord` ADD COLUMN `contentBytes` LONGBLOB;
ALTER TABLE `AutomationRun` ADD COLUMN `resultEnvelopeBytes` LONGBLOB;
ALTER TABLE `AutomationRun` ADD COLUMN `workflowCheckpointEnvelopeBytes` LONGBLOB;
ALTER TABLE `AccountSettingsSnapshot` ADD COLUMN `settingsDbValueBytes` LONGBLOB;
