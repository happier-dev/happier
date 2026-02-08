-- CreateTable
CREATE TABLE "VoiceSessionLease" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "periodKey" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "elevenLabsAgentId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceSessionLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceSessionLease_accountId_expiresAt_idx" ON "VoiceSessionLease"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "VoiceSessionLease_accountId_periodKey_idx" ON "VoiceSessionLease"("accountId", "periodKey");

-- AddForeignKey
ALTER TABLE "VoiceSessionLease" ADD CONSTRAINT "VoiceSessionLease_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

