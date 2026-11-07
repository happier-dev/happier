-- CreateTable
CREATE TABLE "AppLockRecovery" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "recoveryKey" TEXT NOT NULL,
    "codeHash" TEXT,
    "codePurpose" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "codeSentAt" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppLockRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppLockMailSettings" (
    "accountId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "security" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEncrypted" BYTEA,
    "fromAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppLockMailSettings_pkey" PRIMARY KEY ("accountId")
);

-- CreateIndex
CREATE INDEX "AppLockRecovery_accountId_idx" ON "AppLockRecovery"("accountId");

-- AddForeignKey
ALTER TABLE "AppLockRecovery" ADD CONSTRAINT "AppLockRecovery_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppLockMailSettings" ADD CONSTRAINT "AppLockMailSettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
