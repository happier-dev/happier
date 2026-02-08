-- CreateTable
CREATE TABLE "AccountIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "providerLogin" TEXT,
    "profile" TEXT,
    "token" BLOB,
    "scopes" TEXT,
    "eligibilityStatus" TEXT NOT NULL DEFAULT 'unknown',
    "eligibilityReason" TEXT,
    "eligibilityCheckedAt" DATETIME,
    "eligibilityNextCheckAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountIdentity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AccountIdentity_accountId_idx" ON "AccountIdentity"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountIdentity_provider_providerUserId_key" ON "AccountIdentity"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountIdentity_accountId_provider_key" ON "AccountIdentity"("accountId", "provider");
