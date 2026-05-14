-- Add explicit installation identity and machine replacement metadata.
ALTER TABLE "Machine" ADD COLUMN "installationId" TEXT;
ALTER TABLE "Machine" ADD COLUMN "installationPublicKey" BLOB;
ALTER TABLE "Machine" ADD COLUMN "contentPublicKeyFingerprint" TEXT;
ALTER TABLE "Machine" ADD COLUMN "replacedByMachineId" TEXT;
ALTER TABLE "Machine" ADD COLUMN "replacedAt" DATETIME;
ALTER TABLE "Machine" ADD COLUMN "replacementReason" TEXT;
ALTER TABLE "Machine" ADD COLUMN "replacementSource" TEXT;
ALTER TABLE "Machine" ADD COLUMN "replacementActorUserId" TEXT;

CREATE INDEX "Machine_accountId_installationId_idx" ON "Machine"("accountId", "installationId");
CREATE INDEX "Machine_accountId_replacedByMachineId_idx" ON "Machine"("accountId", "replacedByMachineId");
CREATE INDEX "Machine_accountId_replacedAt_idx" ON "Machine"("accountId", "replacedAt");
