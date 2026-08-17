-- Unreleased Pending same-row response-loss rejoin facts.
ALTER TABLE "SessionPendingMessage"
    ADD COLUMN "predecessorLocalId" TEXT;

ALTER TABLE "SessionPendingMessage"
    ADD COLUMN "replacementMutationFingerprint" TEXT;
