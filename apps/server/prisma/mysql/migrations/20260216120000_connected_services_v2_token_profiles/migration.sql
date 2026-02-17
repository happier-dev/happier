-- Add profile-aware connected service token storage and refresh lease coordination.

ALTER TABLE `ServiceAccountToken`
    ADD COLUMN `profileId` VARCHAR(191) NOT NULL DEFAULT 'default',
    ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `refreshLeaseOwnerMachineId` VARCHAR(191) NULL,
    ADD COLUMN `refreshLeaseExpiresAt` DATETIME(3) NULL;

DROP INDEX `ServiceAccountToken_accountId_vendor_key` ON `ServiceAccountToken`;
CREATE UNIQUE INDEX `ServiceAccountToken_accountId_vendor_profileId_key`
ON `ServiceAccountToken`(`accountId`, `vendor`, `profileId`);

