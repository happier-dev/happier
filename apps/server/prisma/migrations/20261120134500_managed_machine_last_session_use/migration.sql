ALTER TABLE "ManagedMachine" ADD COLUMN "lastSessionStartedAt" TIMESTAMP(3);
CREATE INDEX "ManagedMachine_preset_usage_idx" ON "ManagedMachine"("homeId", "presetId", "lastSessionStartedAt");
