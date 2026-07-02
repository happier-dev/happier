CREATE TABLE "AccountSettingsSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "settingsDbValue" TEXT,
    "encryptionMode" TEXT NOT NULL,
    "contentKind" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSettingsSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AccountSettingsSnapshot_accountId_version_key"
ON "AccountSettingsSnapshot"("accountId", "version");

CREATE INDEX "AccountSettingsSnapshot_accountId_version_idx"
ON "AccountSettingsSnapshot"("accountId", "version");

CREATE INDEX "AccountSettingsSnapshot_createdAt_idx"
ON "AccountSettingsSnapshot"("createdAt");
