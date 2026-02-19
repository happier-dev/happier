-- Add revoke marker for machines.

ALTER TABLE `Machine` ADD COLUMN `revokedAt` DATETIME(3) NULL;

CREATE INDEX `Machine_accountId_revokedAt_idx` ON `Machine`(`accountId`, `revokedAt`);

