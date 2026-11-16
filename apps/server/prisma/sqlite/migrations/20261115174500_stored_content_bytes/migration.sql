-- Additive storage only. Legacy rows remain readable; no backfill.
ALTER TABLE "Session" ADD COLUMN "metadataBytes" BLOB;
ALTER TABLE "Session" ADD COLUMN "agentStateBytes" BLOB;
ALTER TABLE "Machine" ADD COLUMN "metadataBytes" BLOB;
ALTER TABLE "Machine" ADD COLUMN "daemonStateBytes" BLOB;
ALTER TABLE "SessionSystemRecord" ADD COLUMN "contentBytes" BLOB;
ALTER TABLE "AutomationRun" ADD COLUMN "resultEnvelopeBytes" BLOB;
ALTER TABLE "AutomationRun" ADD COLUMN "workflowCheckpointEnvelopeBytes" BLOB;
ALTER TABLE "AccountSettingsSnapshot" ADD COLUMN "settingsDbValueBytes" BLOB;
