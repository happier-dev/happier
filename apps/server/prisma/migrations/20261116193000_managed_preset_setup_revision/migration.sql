ALTER TABLE "ManagedMachinePreset" ADD COLUMN "setupRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ManagedMachine" ADD COLUMN "presetSetupRevision" INTEGER;

-- Only an exact current preset snapshot has a known initial setup counter.
UPDATE "ManagedMachine"
SET "presetSetupRevision" = 0
WHERE EXISTS (
    SELECT 1 FROM "ManagedMachinePreset" AS preset
    WHERE preset."id" = "ManagedMachine"."presetId"
      AND preset."homeId" = "ManagedMachine"."homeId"
      AND preset."revision" = "ManagedMachine"."presetRevision"
);
