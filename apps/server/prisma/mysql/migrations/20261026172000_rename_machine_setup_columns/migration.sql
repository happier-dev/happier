ALTER TABLE `ManagedMachinePreset` RENAME COLUMN `environment` TO `setup`;
ALTER TABLE `ManagedMachine` RENAME COLUMN `environmentSetup` TO `machineSetup`;
UPDATE `ManagedMachine`
SET `machineSetup` = JSON_SET(JSON_REMOVE(`machineSetup`, '$.environment'),
  '$.setup', JSON_EXTRACT(`machineSetup`, '$.environment'))
WHERE JSON_TYPE(`machineSetup`) = 'OBJECT'
  AND JSON_CONTAINS_PATH(`machineSetup`, 'one', '$.environment');

UPDATE `ManagedMachine`
SET `admittedInput` = JSON_SET(JSON_REMOVE(`admittedInput`, '$.environmentSetup'),
  '$.machineSetup', JSON_EXTRACT(`admittedInput`, '$.environmentSetup'))
WHERE JSON_TYPE(`admittedInput`) = 'OBJECT'
  AND JSON_CONTAINS_PATH(`admittedInput`, 'one', '$.environmentSetup');

UPDATE `ManagedMachine`
SET `reviewedFacts` = JSON_SET(JSON_REMOVE(`reviewedFacts`, '$.environment'),
  '$.setup', JSON_EXTRACT(`reviewedFacts`, '$.environment'))
WHERE JSON_TYPE(`reviewedFacts`) = 'OBJECT'
  AND JSON_CONTAINS_PATH(`reviewedFacts`, 'one', '$.environment');

UPDATE `ManagedMachine`
SET `admittedInput` = JSON_SET(JSON_REMOVE(`admittedInput`, '$.computeInput.reviewedFacts.environment'),
  '$.computeInput.reviewedFacts.setup', JSON_EXTRACT(`admittedInput`, '$.computeInput.reviewedFacts.environment'))
WHERE JSON_TYPE(JSON_EXTRACT(`admittedInput`, '$.computeInput.reviewedFacts')) = 'OBJECT'
  AND JSON_CONTAINS_PATH(`admittedInput`, 'one', '$.computeInput.reviewedFacts.environment');
