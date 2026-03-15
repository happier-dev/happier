-- CreateTable
CREATE TABLE "AuthPairingSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "requestedPublicKey" TEXT,
    "requestedDeviceLabel" TEXT,
    "requestedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuthPairingSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AuthPairingSession_accountId_expiresAt_idx" ON "AuthPairingSession"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthPairingSession_expiresAt_idx" ON "AuthPairingSession"("expiresAt");
