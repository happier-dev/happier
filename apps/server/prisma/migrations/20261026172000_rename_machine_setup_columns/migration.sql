ALTER TABLE "ManagedMachinePreset" RENAME COLUMN "environment" TO "setup";
ALTER TABLE "ManagedMachine" RENAME COLUMN "environmentSetup" TO "machineSetup";
UPDATE "ManagedMachine"
SET "machineSetup" = ("machineSetup" - 'environment')
  || jsonb_build_object('setup', "machineSetup" -> 'environment')
WHERE jsonb_typeof("machineSetup") = 'object' AND "machineSetup" ? 'environment';

UPDATE "ManagedMachine"
SET "admittedInput" = ("admittedInput" - 'environmentSetup')
  || jsonb_build_object('machineSetup', "admittedInput" -> 'environmentSetup')
WHERE jsonb_typeof("admittedInput") = 'object' AND "admittedInput" ? 'environmentSetup';

UPDATE "ManagedMachine"
SET "reviewedFacts" = ("reviewedFacts" - 'environment')
  || jsonb_build_object('setup', "reviewedFacts" -> 'environment')
WHERE jsonb_typeof("reviewedFacts") = 'object' AND "reviewedFacts" ? 'environment';

UPDATE "ManagedMachine"
SET "admittedInput" = jsonb_set("admittedInput", '{computeInput,reviewedFacts}',
  (("admittedInput" #> '{computeInput,reviewedFacts}') - 'environment')
    || jsonb_build_object('setup', "admittedInput" #> '{computeInput,reviewedFacts,environment}'), false)
WHERE jsonb_typeof("admittedInput" #> '{computeInput,reviewedFacts}') = 'object'
  AND ("admittedInput" #> '{computeInput,reviewedFacts}') ? 'environment';
