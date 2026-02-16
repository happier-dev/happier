-- Add sealed quota snapshot storage for connected services.

CREATE TABLE "ServiceAccountQuotaSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "profileId" TEXT NOT NULL DEFAULT 'default',
    "snapshot" BLOB NOT NULL,
    "status" TEXT,
    "fetchedAt" DATETIME,
    "staleAfterMs" INTEGER,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "ServiceAccountQuotaSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ServiceAccountQuotaSnapshot_accountId_vendor_profileId_key"
ON "ServiceAccountQuotaSnapshot"("accountId", "vendor", "profileId");

CREATE INDEX "ServiceAccountQuotaSnapshot_accountId_idx"
ON "ServiceAccountQuotaSnapshot"("accountId");

