-- AlterTable
-- The materialized attention fact, maintained by the database rather than by application writers.
--
-- Every arm of the attention predicate is a column of this same row, so a generated column
-- expresses it exactly. A writer running older code, a rolled-back binary, a psql session, or a
-- future writer that has never heard of this column all keep it correct.
ALTER TABLE "Session" ADD COLUMN "needsAttention" BOOLEAN NOT NULL GENERATED ALWAYS AS (
    "seq" > COALESCE("lastViewedSessionSeq", 0)
    OR COALESCE("latestTurnStatus", '') = 'failed'
    OR "pendingPermissionRequestCount" > 0
    OR "pendingUserActionRequestCount" > 0
) STORED;

-- CreateIndex
CREATE INDEX "Session_accountId_needsAttention_meaningfulActivityAt_id_idx"
ON "Session"("accountId", "needsAttention", "meaningfulActivityAt" DESC, "id" DESC);
