-- Final unreleased runtime-activity projection.
ALTER TABLE "Session"
    ADD COLUMN "runtimeActivityState" TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN "runtimeActivityActiveCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "runtimeActivityObservedAt" BIGINT,
    ADD COLUMN "runtimeActivityRevision" BIGINT NOT NULL DEFAULT 0,
    ALTER COLUMN "active" SET DEFAULT false;
