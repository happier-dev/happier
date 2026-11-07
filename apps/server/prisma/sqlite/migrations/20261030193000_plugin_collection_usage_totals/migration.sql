ALTER TABLE "Account" ADD COLUMN "pluginCollectionRows" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Account" ADD COLUMN "pluginCollectionEncodedBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "PluginCollectionIndexState" ADD COLUMN "quotaPrefixCounts" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "PluginCollectionUsage" (
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "rows" BIGINT NOT NULL DEFAULT 0,
    "encodedBytes" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "PluginCollectionUsage_pkey" PRIMARY KEY ("accountId", "pluginId", "collectionId"),
    CONSTRAINT "PluginCollectionUsage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PluginCollectionContractUsage" (
    "accountId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "rows" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "PluginCollectionContractUsage_pkey" PRIMARY KEY ("accountId", "contractId"),
    CONSTRAINT "PluginCollectionContractUsage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionContractUsage_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PluginCollectionContract"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Preserve the existing live-row lookup while letting readiness read the maximum revision from its index.
DROP INDEX "PluginCollectionRow_account_live_idx";
CREATE INDEX "PluginCollectionRow_account_live_idx" ON "PluginCollectionRow" ("accountId", "pluginId", "collectionId", "deletedAt", "revision");

