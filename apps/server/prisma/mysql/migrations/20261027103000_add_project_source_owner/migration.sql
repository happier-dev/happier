ALTER TABLE `ProjectSource` ADD COLUMN `owner` JSON NULL;
UPDATE `ProjectSource`
SET `owner` = JSON_OBJECT('kind', 'account', 'accountId', `createdByAccountId`);
