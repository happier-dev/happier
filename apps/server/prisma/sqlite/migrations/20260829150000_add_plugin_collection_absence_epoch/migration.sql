CREATE TABLE "PluginCollectionAbsenceEpoch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginCollectionAbsenceEpoch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PluginCollectionAbsenceEpoch_account_collection_key"
    ON "PluginCollectionAbsenceEpoch"("accountId", "pluginId", "collectionId");
