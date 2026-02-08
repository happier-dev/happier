-- AlterTable
ALTER TABLE "Session" ADD COLUMN "pendingVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "pendingCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SessionPendingMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "authorAccountId" TEXT,
    "localId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "position" INTEGER NOT NULL,
    "discardedAt" DATETIME,
    "discardedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionPendingMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionPendingMessage_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionPendingMessage_sessionId_localId_key" ON "SessionPendingMessage"("sessionId", "localId");

-- CreateIndex
CREATE INDEX "SessionPendingMessage_sessionId_status_position_idx" ON "SessionPendingMessage"("sessionId", "status", "position");

-- CreateIndex
CREATE INDEX "SessionPendingMessage_sessionId_authorAccountId_idx" ON "SessionPendingMessage"("sessionId", "authorAccountId");

-- CreateIndex
CREATE INDEX "SessionPendingMessage_sessionId_status_updatedAt_idx" ON "SessionPendingMessage"("sessionId", "status", "updatedAt");
