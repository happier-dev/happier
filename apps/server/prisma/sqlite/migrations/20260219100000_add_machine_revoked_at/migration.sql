-- Add revoke marker for machines.

ALTER TABLE "Machine" ADD COLUMN "revokedAt" DATETIME;

CREATE INDEX "Machine_accountId_revokedAt_idx" ON "Machine"("accountId", "revokedAt");

