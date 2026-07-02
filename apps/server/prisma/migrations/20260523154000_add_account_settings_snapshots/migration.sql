CREATE TABLE "AccountSettingsSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "settingsDbValue" TEXT,
    "encryptionMode" TEXT NOT NULL,
    "contentKind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSettingsSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AccountSettingsSnapshot" ADD CONSTRAINT "AccountSettingsSnapshot_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AccountSettingsSnapshot_accountId_version_key"
ON "AccountSettingsSnapshot"("accountId", "version");

CREATE INDEX "AccountSettingsSnapshot_accountId_version_idx"
ON "AccountSettingsSnapshot"("accountId", "version");

CREATE INDEX "AccountSettingsSnapshot_createdAt_idx"
ON "AccountSettingsSnapshot"("createdAt");
