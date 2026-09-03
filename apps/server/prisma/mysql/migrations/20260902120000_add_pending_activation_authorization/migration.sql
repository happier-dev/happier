ALTER TABLE `Session`
ADD COLUMN `pendingActivationRequestId` VARCHAR(191) NULL,
ADD COLUMN `pendingActivationRequestedAt` DATETIME(3) NULL,
ADD COLUMN `pendingActivationStatus` VARCHAR(191) NULL,
ADD COLUMN `pendingActivationFailureCode` VARCHAR(191) NULL;
