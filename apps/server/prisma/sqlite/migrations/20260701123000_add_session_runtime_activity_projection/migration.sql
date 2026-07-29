-- Final unreleased runtime-activity projection.
ALTER TABLE "Session" ADD COLUMN "runtimeActivityState" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "Session" ADD COLUMN "runtimeActivityActiveCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "runtimeActivityObservedAt" BIGINT;
ALTER TABLE "Session" ADD COLUMN "runtimeActivityRevision" BIGINT NOT NULL DEFAULT 0;

-- SQLite cannot alter a column default in place. Preserve the existing value while
-- replacing only the default for newly created sessions.
ALTER TABLE "Session" ADD COLUMN "activeCanonical" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Session" SET "activeCanonical" = "active";
ALTER TABLE "Session" DROP COLUMN "active";
ALTER TABLE "Session" RENAME COLUMN "activeCanonical" TO "active";
