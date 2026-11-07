ALTER TABLE "ManagedMachinePreset" RENAME COLUMN "environment" TO "setup";
ALTER TABLE "ManagedMachine" RENAME COLUMN "environmentSetup" TO "machineSetup";
UPDATE "ManagedMachine"
SET "machineSetup" = json_set(json_remove("machineSetup", '$.environment'),
  '$.setup', json(json_extract("machineSetup", '$.environment')))
WHERE json_type("machineSetup") = 'object'
  AND json_type("machineSetup", '$.environment') IS NOT NULL;

UPDATE "ManagedMachine"
SET "admittedInput" = json_set(json_remove("admittedInput", '$.environmentSetup'),
  '$.machineSetup', json(json_extract("admittedInput", '$.environmentSetup')))
WHERE json_type("admittedInput") = 'object'
  AND json_type("admittedInput", '$.environmentSetup') IS NOT NULL;

UPDATE "ManagedMachine"
SET "reviewedFacts" = json_set(json_remove("reviewedFacts", '$.environment'),
  '$.setup', json(json_extract("reviewedFacts", '$.environment')))
WHERE json_type("reviewedFacts") = 'object'
  AND json_type("reviewedFacts", '$.environment') IS NOT NULL;

UPDATE "ManagedMachine"
SET "admittedInput" = json_set(json_remove("admittedInput", '$.computeInput.reviewedFacts.environment'),
  '$.computeInput.reviewedFacts.setup', json(json_extract("admittedInput", '$.computeInput.reviewedFacts.environment')))
WHERE json_type("admittedInput", '$.computeInput.reviewedFacts') = 'object'
  AND json_type("admittedInput", '$.computeInput.reviewedFacts.environment') IS NOT NULL;
