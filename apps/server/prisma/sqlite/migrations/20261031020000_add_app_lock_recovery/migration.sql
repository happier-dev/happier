-- CreateTable
CREATE TABLE "AppLockRecovery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "recoveryKey" TEXT NOT NULL,
    "codeHash" TEXT,
    "codePurpose" TEXT,
    "codeExpiresAt" DATETIME,
    "codeSentAt" DATETIME,
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppLockRecovery_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppLockMailSettings" (
    "accountId" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "security" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEncrypted" BLOB,
    "fromAddress" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppLockMailSettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AppLockRecovery_accountId_idx" ON "AppLockRecovery"("accountId");
