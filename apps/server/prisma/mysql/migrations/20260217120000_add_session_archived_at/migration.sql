-- Add global archive marker for sessions.

ALTER TABLE `Session` ADD COLUMN `archivedAt` DATETIME(3) NULL;

CREATE INDEX `Session_accountId_archivedAt_idx` ON `Session`(`accountId`, `archivedAt`);

