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
