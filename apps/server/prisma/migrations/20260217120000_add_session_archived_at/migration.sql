-- Add global archive marker for sessions.

ALTER TABLE "Session" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Session_accountId_archivedAt_idx" ON "Session"("accountId", "archivedAt" DESC);

