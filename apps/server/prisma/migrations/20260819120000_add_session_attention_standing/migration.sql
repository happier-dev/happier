-- CreateTable
CREATE TABLE "SessionAttentionStanding" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "standing" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionAttentionStanding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionAttentionStanding_accountId_standing_idx" ON "SessionAttentionStanding"("accountId", "standing");

-- CreateIndex
CREATE INDEX "SessionAttentionStanding_sessionId_idx" ON "SessionAttentionStanding"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionAttentionStanding_accountId_sessionId_key" ON "SessionAttentionStanding"("accountId", "sessionId");

-- AddForeignKey
ALTER TABLE "SessionAttentionStanding" ADD CONSTRAINT "SessionAttentionStanding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionAttentionStanding" ADD CONSTRAINT "SessionAttentionStanding_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
