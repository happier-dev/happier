-- AlterTable
ALTER TABLE `Session` ADD COLUMN `latestTurnStatus` VARCHAR(191) NULL,
    ADD COLUMN `lastRuntimeIssue` LONGTEXT NULL;
