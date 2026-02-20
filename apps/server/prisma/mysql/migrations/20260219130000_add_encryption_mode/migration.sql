-- AlterTable
ALTER TABLE `Account` ADD COLUMN `encryptionMode` VARCHAR(191) NOT NULL DEFAULT 'e2ee';
-- Vitess/Planetscale compatibility: avoid non-constant defaults in ALTER TABLE.
ALTER TABLE `Account` ADD COLUMN `encryptionModeUpdatedAt` DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000';
UPDATE `Account` SET `encryptionModeUpdatedAt` = `updatedAt` WHERE `encryptionModeUpdatedAt` = '1970-01-01 00:00:00.000';

-- AlterTable
ALTER TABLE `Session` ADD COLUMN `encryptionMode` VARCHAR(191) NOT NULL DEFAULT 'e2ee';
