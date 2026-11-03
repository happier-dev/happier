-- Retain the existing presence owner's committed decisions without initial-state backfill.
ALTER TABLE "Machine" ADD COLUMN "presenceTransitions" TEXT;
