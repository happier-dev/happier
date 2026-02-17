-- Add sealed quota snapshot storage for connected services.

CREATE TABLE "ServiceAccountQuotaSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "profileId" TEXT NOT NULL DEFAULT 'default',
    "snapshot" BYTEA NOT NULL,
    "status" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "staleAfterMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAccountQuotaSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ServiceAccountQuotaSnapshot" ADD CONSTRAINT "ServiceAccountQuotaSnapshot_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ServiceAccountQuotaSnapshot_accountId_vendor_profileId_key"
ON "ServiceAccountQuotaSnapshot"("accountId", "vendor", "profileId");

CREATE INDEX "ServiceAccountQuotaSnapshot_accountId_idx"
ON "ServiceAccountQuotaSnapshot"("accountId");

