-- AlterTable
ALTER TABLE "ReviewMetadata" ADD COLUMN "sourceSessionId" TEXT;
ALTER TABLE "ReviewMetadata" ADD COLUMN "sourceSessionSeq" INTEGER;
ALTER TABLE "ReviewMetadata" ADD COLUMN "workflowRunId" TEXT;

-- CreateIndex
CREATE INDEX "ReviewMetadata_workflowRunId_idx" ON "ReviewMetadata"("workflowRunId");

-- CreateIndex
CREATE INDEX "ReviewMetadata_sourceSessionId_state_startedAt_artifactId_idx" ON "ReviewMetadata"("sourceSessionId", "state", "startedAt" DESC, "artifactId");
