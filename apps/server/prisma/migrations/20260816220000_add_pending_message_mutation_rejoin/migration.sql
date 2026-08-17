-- Unreleased Pending same-row response-loss rejoin facts.
ALTER TABLE "SessionPendingMessage"
    ADD COLUMN "predecessorLocalId" TEXT,
    ADD COLUMN "replacementMutationFingerprint" TEXT;
