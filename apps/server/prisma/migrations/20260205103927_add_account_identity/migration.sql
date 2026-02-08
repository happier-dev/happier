-- CreateEnum
CREATE TYPE "AccountIdentityEligibilityStatus" AS ENUM ('unknown', 'eligible', 'ineligible');

-- CreateTable
CREATE TABLE "AccountIdentity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "providerLogin" TEXT,
    "profile" JSONB,
    "token" BYTEA,
    "scopes" TEXT,
    "eligibilityStatus" "AccountIdentityEligibilityStatus" NOT NULL DEFAULT 'unknown',
    "eligibilityReason" TEXT,
    "eligibilityCheckedAt" TIMESTAMP(3),
    "eligibilityNextCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountIdentity_accountId_idx" ON "AccountIdentity"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountIdentity_provider_providerUserId_key" ON "AccountIdentity"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountIdentity_accountId_provider_key" ON "AccountIdentity"("accountId", "provider");

-- AddForeignKey
ALTER TABLE "AccountIdentity" ADD CONSTRAINT "AccountIdentity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

