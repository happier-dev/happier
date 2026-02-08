-- Add claim-secret gating to terminal auth requests.
ALTER TABLE `TerminalAuthRequest` ADD COLUMN `claimSecretHash` VARCHAR(191) NULL;
ALTER TABLE `TerminalAuthRequest` ADD COLUMN `claimedAt` DATETIME(3) NULL;

