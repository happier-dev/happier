-- CreateTable
CREATE TABLE "KeyChallengeV2" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "audienceOrigin" TEXT NOT NULL,
    "audienceServerIdentityId" TEXT,
    "expectedAccountId" TEXT,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "KeyChallengeV2_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KeyChallengeV2_expiresAt_idx" ON "KeyChallengeV2"("expiresAt");

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "tokenEpoch" INTEGER NOT NULL DEFAULT 0;

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
