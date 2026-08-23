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
