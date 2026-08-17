-- Unreleased Pending same-row response-loss rejoin facts.
ALTER TABLE `SessionPendingMessage`
    ADD COLUMN `predecessorLocalId` VARCHAR(191) NULL,
    ADD COLUMN `replacementMutationFingerprint` VARCHAR(43) NULL;
