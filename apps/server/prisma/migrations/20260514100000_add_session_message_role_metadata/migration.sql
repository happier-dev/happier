-- AlterTable
ALTER TABLE "SessionMessage" ADD COLUMN "messageRole" TEXT;

-- AlterTable
ALTER TABLE "SessionPendingMessage" ADD COLUMN "messageRole" TEXT;

-- CreateIndex
CREATE INDEX "SessionMessage_sessionId_messageRole_seq_idx" ON "SessionMessage"("sessionId", "messageRole", "seq");

-- CreateIndex
CREATE INDEX "SessionMessage_sessionId_sidechainId_messageRole_seq_idx" ON "SessionMessage"("sessionId", "sidechainId", "messageRole", "seq");
