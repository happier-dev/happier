-- CreateTable
CREATE TABLE "AuthPairingSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "requestedPublicKey" TEXT,
    "requestedDeviceLabel" TEXT,
    "requestedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthPairingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthPairingSession_accountId_expiresAt_idx" ON "AuthPairingSession"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthPairingSession_expiresAt_idx" ON "AuthPairingSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "AuthPairingSession" ADD CONSTRAINT "AuthPairingSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
