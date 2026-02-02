-- Add a safety floor for the coalesced AccountChange feed.
-- When old/orphan change rows are pruned (e.g. deleted sessions), clients with `after < changesFloor`
-- must resync via snapshot to avoid missing deletion signals.

ALTER TABLE "Account" ADD COLUMN "changesFloor" INTEGER NOT NULL DEFAULT 0;

