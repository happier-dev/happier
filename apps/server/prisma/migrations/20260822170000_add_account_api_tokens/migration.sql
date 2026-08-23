-- CreateTable
CREATE TABLE "AccountApiToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "displayPrefix" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AccountApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountApiToken_accountId_createdAt_idx" ON "AccountApiToken"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "AccountApiToken" ADD CONSTRAINT "AccountApiToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
