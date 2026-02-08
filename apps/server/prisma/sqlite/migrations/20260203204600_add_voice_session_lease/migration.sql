-- CreateTable
CREATE TABLE "VoiceSessionLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "periodKey" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "elevenLabsAgentId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoiceSessionLease_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "VoiceSessionLease_accountId_expiresAt_idx" ON "VoiceSessionLease"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "VoiceSessionLease_accountId_periodKey_idx" ON "VoiceSessionLease"("accountId", "periodKey");

