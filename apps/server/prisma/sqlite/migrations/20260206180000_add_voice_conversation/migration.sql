-- CreateTable
CREATE TABLE "VoiceConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "leaseId" TEXT,
    "providerId" TEXT NOT NULL,
    "providerConversationId" TEXT NOT NULL,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "durationSeconds" INTEGER NOT NULL,
    "billedUnits" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoiceConversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VoiceConversation_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "VoiceSessionLease" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceConversation_leaseId_key" ON "VoiceConversation"("leaseId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceConversation_providerId_providerConversationId_key" ON "VoiceConversation"("providerId", "providerConversationId");

-- CreateIndex
CREATE INDEX "VoiceConversation_accountId_createdAt_idx" ON "VoiceConversation"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceConversation_accountId_providerId_createdAt_idx" ON "VoiceConversation"("accountId", "providerId", "createdAt");

