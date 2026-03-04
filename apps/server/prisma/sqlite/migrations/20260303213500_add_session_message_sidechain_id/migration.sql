-- AlterTable
ALTER TABLE "SessionMessage" ADD COLUMN "sidechainId" TEXT;

-- CreateIndex
CREATE INDEX "SessionMessage_sessionId_sidechainId_seq_idx" ON "SessionMessage"("sessionId", "sidechainId", "seq");

