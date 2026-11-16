ALTER TABLE "ManagedMachinePreset" ADD COLUMN "configurationRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ManagedMachine" ADD COLUMN "presetConfigurationRevision" INTEGER;

-- Only the current row revision proves a retained opaque snapshot still matches.
-- Older revisions remain unknown and cannot participate in configuration reuse.
UPDATE "ManagedMachine"
SET "presetConfigurationRevision" = 0
WHERE EXISTS (
    SELECT 1 FROM "ManagedMachinePreset" AS preset
    WHERE preset."id" = "ManagedMachine"."presetId"
      AND preset."homeId" = "ManagedMachine"."homeId"
      AND preset."revision" = "ManagedMachine"."presetRevision"
);
