-- CreateTable
CREATE TABLE "PluginCollectionAccountGrant" (
    "rowDbId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("rowDbId", "accountId"),
    CONSTRAINT "PluginCollectionAccountGrant_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionAccountGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionAccountGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PluginCollectionTeamGrant" (
    "rowDbId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("rowDbId", "teamId"),
    CONSTRAINT "PluginCollectionTeamGrant_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionTeamGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionTeamGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PluginCollectionGroupGrant" (
    "rowDbId" TEXT NOT NULL,
    "teamGroupId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("rowDbId", "teamGroupId"),
    CONSTRAINT "PluginCollectionGroupGrant_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionGroupGrant_teamGroupId_fkey" FOREIGN KEY ("teamGroupId") REFERENCES "TeamGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionGroupGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PluginCollectionKeyEnvelope" (
    "rowDbId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "encryptedDataKey" BLOB NOT NULL,
    "recipientContentPublicKeyFingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("rowDbId", "recipientAccountId"),
    CONSTRAINT "PluginCollectionKeyEnvelope_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionKeyEnvelope_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PluginCollectionAccountGrant_accountId_rowDbId_idx" ON "PluginCollectionAccountGrant"("accountId", "rowDbId");

-- CreateIndex
CREATE INDEX "PluginCollectionTeamGrant_teamId_rowDbId_idx" ON "PluginCollectionTeamGrant"("teamId", "rowDbId");

-- CreateIndex
CREATE INDEX "PluginCollectionGroupGrant_teamGroupId_rowDbId_idx" ON "PluginCollectionGroupGrant"("teamGroupId", "rowDbId");

-- CreateIndex
CREATE INDEX "PluginCollectionKeyEnvelope_recipientAccountId_rowDbId_idx" ON "PluginCollectionKeyEnvelope"("recipientAccountId", "rowDbId");

