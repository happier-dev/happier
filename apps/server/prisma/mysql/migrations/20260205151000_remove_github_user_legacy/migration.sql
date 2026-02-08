-- Drop legacy GitHub linkage on Account in favor of AccountIdentity(provider="github").

INSERT IGNORE INTO `AccountIdentity` (
  `id`,
  `accountId`,
  `provider`,
  `providerUserId`,
  `providerLogin`,
  `profile`,
  `token`,
  `createdAt`,
  `updatedAt`
)
SELECT
  CONCAT('gh-legacy-', a.`id`),
  a.`id`,
  'github',
  a.`githubUserId`,
  JSON_UNQUOTE(JSON_EXTRACT(g.`profile`, '$.login')),
  g.`profile`,
  g.`token`,
  NOW(3),
  NOW(3)
FROM `Account` a
LEFT JOIN `GithubUser` g ON g.`id` = a.`githubUserId`
WHERE a.`githubUserId` IS NOT NULL;

-- MySQL lacks IF EXISTS for many of these operations, so use information_schema + dynamic SQL
-- to keep this migration safe on fresh installs and repeated runs.
SET @fk := (
  SELECT CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'Account'
    AND CONSTRAINT_NAME = 'Account_githubUserId_fkey'
  LIMIT 1
);
SET @sql := IF(@fk IS NULL, 'SELECT 1', 'ALTER TABLE `Account` DROP FOREIGN KEY `Account_githubUserId_fkey`');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx := (
  SELECT INDEX_NAME
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'Account'
    AND INDEX_NAME = 'Account_githubUserId_key'
  LIMIT 1
);
SET @sql := IF(@idx IS NULL, 'SELECT 1', 'DROP INDEX `Account_githubUserId_key` ON `Account`');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (
  SELECT COLUMN_NAME
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'Account'
    AND COLUMN_NAME = 'githubUserId'
  LIMIT 1
);
SET @sql := IF(@col IS NULL, 'SELECT 1', 'ALTER TABLE `Account` DROP COLUMN `githubUserId`');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

DROP TABLE IF EXISTS `GithubUser`;
