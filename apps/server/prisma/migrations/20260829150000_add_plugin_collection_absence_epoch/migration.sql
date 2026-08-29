CREATE TABLE "PluginCollectionAbsenceEpoch" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT COLLATE "C" NOT NULL,
    "collectionId" TEXT COLLATE "C" NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PluginCollectionAbsenceEpoch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PluginCollectionAbsenceEpoch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PluginCollectionAbsenceEpoch_account_collection_key"
    ON "PluginCollectionAbsenceEpoch"("accountId", "pluginId", "collectionId");
