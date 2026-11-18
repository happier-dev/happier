UPDATE `ManagedMachine` AS machine
SET `admittedInput` = JSON_SET(machine.`admittedInput`, '$.resourceBoundSessionEnded', JSON_EXTRACT('true', '$'))
WHERE JSON_UNQUOTE(JSON_EXTRACT(machine.`admittedInput`, '$.acquisitionMode')) = 'resource-bound'
  AND JSON_UNQUOTE(JSON_EXTRACT(machine.`admittedInput`, '$.enrollmentAccountId')) <> machine.`custodianAccountId`
  AND machine.`creationState` = 'active' AND machine.`allocation` = 'bound' AND machine.`archivedAt` IS NULL
  AND EXISTS (
    SELECT 1 FROM `Session` AS birth
    WHERE birth.`managedCreationId` = machine.id AND birth.`archivedAt` IS NOT NULL
      AND birth.`accountId` = JSON_UNQUOTE(JSON_EXTRACT(machine.`admittedInput`, '$.enrollmentAccountId'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM `Session` AS birth
    WHERE birth.`managedCreationId` = machine.id AND birth.`archivedAt` IS NULL
  );
