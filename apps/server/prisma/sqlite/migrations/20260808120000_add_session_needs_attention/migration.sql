-- AlterTable
-- SQLite only permits VIRTUAL generated columns when adding a column without rebuilding the
-- table. SQLite indexes virtual generated columns, so the attention lookup remains indexed.
ALTER TABLE "Session" ADD COLUMN "needsAttention" BOOLEAN NOT NULL GENERATED ALWAYS AS (
    "seq" > COALESCE("lastViewedSessionSeq", 0)
    OR COALESCE("latestTurnStatus", '') = 'failed'
    OR "pendingPermissionRequestCount" > 0
    OR "pendingUserActionRequestCount" > 0
) VIRTUAL;

-- CreateIndex
CREATE INDEX "Session_accountId_needsAttention_meaningfulActivityAt_id_idx"
ON "Session"("accountId", "needsAttention", "meaningfulActivityAt", "id");
