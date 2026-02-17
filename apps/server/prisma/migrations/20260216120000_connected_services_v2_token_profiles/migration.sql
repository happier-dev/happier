-- Add profile-aware connected service token storage and refresh lease coordination.

ALTER TABLE "ServiceAccountToken"
ADD COLUMN     "profileId" TEXT NOT NULL DEFAULT 'default',
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "refreshLeaseOwnerMachineId" TEXT,
ADD COLUMN     "refreshLeaseExpiresAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "ServiceAccountToken_accountId_vendor_key";
CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_profileId_key"
ON "ServiceAccountToken"("accountId", "vendor", "profileId");

