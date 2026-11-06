-- CreateTable
CREATE TABLE "SessionAppearance" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "displayDbValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionAppearance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionAppearance_sessionId_idx" ON "SessionAppearance"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionAppearance_accountId_sessionId_key" ON "SessionAppearance"("accountId", "sessionId");

-- AddForeignKey
ALTER TABLE "SessionAppearance" ADD CONSTRAINT "SessionAppearance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionAppearance" ADD CONSTRAINT "SessionAppearance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
