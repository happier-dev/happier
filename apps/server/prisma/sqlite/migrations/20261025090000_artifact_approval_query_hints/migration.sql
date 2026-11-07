-- Retained opaque rows are classified by the keyholding daemon bootstrap.
ALTER TABLE "Artifact" ADD COLUMN "approvalState" TEXT;
ALTER TABLE "Artifact" ADD COLUMN "approvalSessionId" TEXT;
CREATE INDEX "Artifact_accountId_kind_approvalState_updatedAt_id_idx" ON "Artifact"("accountId", "kind", "approvalState", "updatedAt", "id");
CREATE INDEX "Artifact_accountId_approvalSessionId_updatedAt_id_idx" ON "Artifact"("accountId", "approvalSessionId", "updatedAt", "id");
