-- Add profile-aware connected service token storage and refresh lease coordination.

ALTER TABLE "ServiceAccountToken" ADD COLUMN "profileId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ServiceAccountToken" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "ServiceAccountToken" ADD COLUMN "refreshLeaseOwnerMachineId" TEXT;
ALTER TABLE "ServiceAccountToken" ADD COLUMN "refreshLeaseExpiresAt" DATETIME;

DROP INDEX IF EXISTS "ServiceAccountToken_accountId_vendor_key";
CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_profileId_key"
ON "ServiceAccountToken"("accountId", "vendor", "profileId");

