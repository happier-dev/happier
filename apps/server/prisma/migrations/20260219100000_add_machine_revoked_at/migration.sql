-- Add revoke marker for machines.

ALTER TABLE "Machine" ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "Machine_accountId_revokedAt_idx" ON "Machine"("accountId", "revokedAt" DESC);

