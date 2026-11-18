UPDATE "ManagedMachine" AS machine
SET "admittedInput" = jsonb_set(machine."admittedInput", '{resourceBoundSessionEnded}', 'true'::jsonb)
WHERE machine."admittedInput"->>'acquisitionMode' = 'resource-bound'
  AND machine."admittedInput"->>'enrollmentAccountId' <> machine."custodianAccountId"
  AND machine."creationState" = 'active' AND machine."allocation" = 'bound' AND machine."archivedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Session" AS birth
    WHERE birth."managedCreationId" = machine.id AND birth."archivedAt" IS NOT NULL
      AND birth."accountId" = machine."admittedInput"->>'enrollmentAccountId'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Session" AS birth
    WHERE birth."managedCreationId" = machine.id AND birth."archivedAt" IS NULL
  );
