-- Additive storage only. Legacy rows remain readable; no backfill.
ALTER TABLE "Session" ADD COLUMN "metadataBytes" BYTEA;
ALTER TABLE "Session" ADD COLUMN "agentStateBytes" BYTEA;
ALTER TABLE "Machine" ADD COLUMN "metadataBytes" BYTEA;
ALTER TABLE "Machine" ADD COLUMN "daemonStateBytes" BYTEA;
ALTER TABLE "SessionSystemRecord" ADD COLUMN "contentBytes" BYTEA;
ALTER TABLE "AutomationRun" ADD COLUMN "resultEnvelopeBytes" BYTEA;
ALTER TABLE "AutomationRun" ADD COLUMN "workflowCheckpointEnvelopeBytes" BYTEA;
ALTER TABLE "AccountSettingsSnapshot" ADD COLUMN "settingsDbValueBytes" BYTEA;
