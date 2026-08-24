-- CreateTable
CREATE TABLE "KeyChallengeV2" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nonce" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "audienceOrigin" TEXT NOT NULL,
    "audienceServerIdentityId" TEXT,
    "expectedAccountId" TEXT,
    "consumedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "KeyChallengeV2_expiresAt_idx" ON "KeyChallengeV2"("expiresAt");

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "tokenEpoch" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AccountApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "displayPrefix" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    CONSTRAINT "AccountApiToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AccountApiToken_accountId_createdAt_idx" ON "AccountApiToken"("accountId", "createdAt");
