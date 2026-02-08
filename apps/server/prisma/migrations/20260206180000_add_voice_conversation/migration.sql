-- CreateTable
CREATE TABLE "VoiceConversation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leaseId" TEXT,
    "providerId" TEXT NOT NULL,
    "providerConversationId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER NOT NULL,
    "billedUnits" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceConversation_leaseId_key" ON "VoiceConversation"("leaseId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceConversation_providerId_providerConversationId_key" ON "VoiceConversation"("providerId", "providerConversationId");

-- CreateIndex
CREATE INDEX "VoiceConversation_accountId_createdAt_idx" ON "VoiceConversation"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceConversation_accountId_providerId_createdAt_idx" ON "VoiceConversation"("accountId", "providerId", "createdAt");

-- AddForeignKey
ALTER TABLE "VoiceConversation" ADD CONSTRAINT "VoiceConversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceConversation" ADD CONSTRAINT "VoiceConversation_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "VoiceSessionLease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

