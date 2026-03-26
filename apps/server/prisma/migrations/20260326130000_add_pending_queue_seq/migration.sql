-- AlterTable
ALTER TABLE "Session" ADD COLUMN "pendingQueueSeq" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing sessions so newly queued items continue after the highest queued position.
UPDATE "Session"
SET "pendingQueueSeq" = GREATEST(
    "pendingQueueSeq",
    COALESCE((
        SELECT MAX("position")
        FROM "SessionPendingMessage"
        WHERE "SessionPendingMessage"."sessionId" = "Session"."id"
          AND "SessionPendingMessage"."status" = 'queued'
    ), 0)
);
