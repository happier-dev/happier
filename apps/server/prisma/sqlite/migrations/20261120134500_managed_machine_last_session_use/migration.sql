ALTER TABLE "ManagedMachine" ADD COLUMN "lastSessionStartedAt" DATETIME;
CREATE INDEX "ManagedMachine_preset_usage_idx" ON "ManagedMachine"("homeId", "presetId", "lastSessionStartedAt");
