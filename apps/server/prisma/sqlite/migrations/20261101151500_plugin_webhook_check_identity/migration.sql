SELECT happier_prepare_plugin_webhook_check_identity();

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PluginWebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "pluginId" TEXT,
    "webhookContributionId" TEXT,
    "handlerActionId" TEXT,
    "sourceInstanceId" TEXT,
    "checkId" TEXT NOT NULL DEFAULT '',
    "checkIdDigest" TEXT NOT NULL DEFAULT '',
    "lastAcceptedAt" DATETIME,
    "ensureIdempotencyKey" TEXT,
    "ensureRequestFingerprint" TEXT,
    "setupKind" TEXT,
    "routeId" TEXT NOT NULL,
    "routingKind" TEXT NOT NULL,
    "providerInstallationId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" DATETIME,
    "releasedAt" DATETIME,
    "providerConfirmedAt" DATETIME,
    "tombstoneExpiresAt" DATETIME,
    "targetMachineId" TEXT,
    "targetMachineInstallationId" TEXT,
    "targetMaterializationId" TEXT,
    "targetPluginVersion" TEXT,
    "previousTargetMachineId" TEXT,
    "previousTargetMachineInstallationId" TEXT,
    "previousTargetMaterializationId" TEXT,
    "previousTargetPluginVersion" TEXT,
    "targetIntentEpoch" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginWebhookEndpoint_routing_kind_check"
        CHECK ("routingKind" IN ('accountEndpoint', 'providerInstallation')),
    CONSTRAINT "PluginWebhookEndpoint_provider_installation_check"
        CHECK (
            ("routingKind" = 'accountEndpoint' AND "providerInstallationId" IS NULL)
            OR
            ("routingKind" = 'providerInstallation' AND "providerInstallationId" IS NOT NULL)
        ),
    CONSTRAINT "PluginWebhookEndpoint_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "PluginWebhookEndpoint_detached_tombstone_check"
        CHECK (
            "accountId" IS NOT NULL
            OR (
                "routingKind" = 'providerInstallation'
                AND "providerInstallationId" IS NOT NULL
                AND "pluginId" IS NULL
                AND "webhookContributionId" IS NULL
                AND "handlerActionId" IS NULL
                AND "sourceInstanceId" IS NULL
                AND "ensureIdempotencyKey" IS NULL
                AND "ensureRequestFingerprint" IS NULL
                AND "setupKind" IS NULL
                AND "enabled" = 0
                AND "revokedAt" IS NULL
                AND "targetMachineId" IS NULL
                AND "targetMachineInstallationId" IS NULL
                AND "targetMaterializationId" IS NULL
                AND "targetPluginVersion" IS NULL
                AND "previousTargetMachineId" IS NULL
                AND "previousTargetMachineInstallationId" IS NULL
                AND "previousTargetMaterializationId" IS NULL
                AND "previousTargetPluginVersion" IS NULL
                AND "releasedAt" IS NOT NULL
                AND "tombstoneExpiresAt" IS NOT NULL
            )
        ),
    CONSTRAINT "PluginWebhookEndpoint_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PluginWebhookEndpoint_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "PluginWebhookRoute" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PluginWebhookEndpoint" ("accountId", "checkId", "checkIdDigest", "createdAt", "enabled", "ensureIdempotencyKey", "ensureRequestFingerprint", "handlerActionId", "id", "lastAcceptedAt", "pluginId", "previousTargetMachineId", "previousTargetMachineInstallationId", "previousTargetMaterializationId", "previousTargetPluginVersion", "providerConfirmedAt", "providerInstallationId", "releasedAt", "revision", "revokedAt", "routeId", "routingKind", "setupKind", "sourceInstanceId", "targetIntentEpoch", "targetMachineId", "targetMachineInstallationId", "targetMaterializationId", "targetPluginVersion", "tombstoneExpiresAt", "updatedAt", "webhookContributionId") SELECT "accountId", "checkId", "checkIdDigest", "createdAt", "enabled", "ensureIdempotencyKey", "ensureRequestFingerprint", "handlerActionId", "id", "lastAcceptedAt", "pluginId", "previousTargetMachineId", "previousTargetMachineInstallationId", "previousTargetMaterializationId", "previousTargetPluginVersion", "providerConfirmedAt", "providerInstallationId", "releasedAt", "revision", "revokedAt", "routeId", "routingKind", "setupKind", "sourceInstanceId", "targetIntentEpoch", "targetMachineId", "targetMachineInstallationId", "targetMaterializationId", "targetPluginVersion", "tombstoneExpiresAt", "updatedAt", "webhookContributionId" FROM "PluginWebhookEndpoint";
DROP TABLE "PluginWebhookEndpoint";
ALTER TABLE "new_PluginWebhookEndpoint" RENAME TO "PluginWebhookEndpoint";
CREATE INDEX "PluginWebhookEndpoint_tombstoneExpiresAt_idx" ON "PluginWebhookEndpoint"("tombstoneExpiresAt");
CREATE UNIQUE INDEX "PluginWebhookEndpoint_accountId_ensureIdempotencyKey_key" ON "PluginWebhookEndpoint"("accountId", "ensureIdempotencyKey");
CREATE UNIQUE INDEX "plugin_webhook_endpoint_account_contribution_source_key" ON "PluginWebhookEndpoint"("accountId", "pluginId", "webhookContributionId", "sourceInstanceId", "checkIdDigest");
CREATE UNIQUE INDEX "PluginWebhookEndpoint_routeId_providerInstallationId_key" ON "PluginWebhookEndpoint"("routeId", "providerInstallationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

