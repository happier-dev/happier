-- AlterTable
ALTER TABLE `Session` ADD COLUMN `lastViewedSessionSeq` INTEGER NULL;
ALTER TABLE `Session` ADD COLUMN `pendingPermissionRequestCount` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `Session` ADD COLUMN `pendingUserActionRequestCount` INTEGER NOT NULL DEFAULT 0;
