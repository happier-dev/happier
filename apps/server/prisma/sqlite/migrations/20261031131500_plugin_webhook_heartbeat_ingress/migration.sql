-- SQLite requires rebuilding the route to extend its CHECK constraint.
-- The migration owner handles these directives outside its transaction.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_PluginWebhookRoute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opaqueRouteId" TEXT COLLATE BINARY NOT NULL,
    "verifierKind" TEXT COLLATE BINARY NOT NULL,
    "routingKind" TEXT COLLATE BINARY NOT NULL,
    "operatorPluginId" TEXT COLLATE BINARY,
    "operatorWebhookContributionId" TEXT COLLATE BINARY,
    "accountEndpointId" TEXT COLLATE BINARY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" DATETIME,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "currentCredentialId" TEXT,
    "previousCredentialId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginWebhookRoute_verifier_kind_check"
        CHECK ("verifierKind" IN ('github_hmac_sha256_v1', 'capabilityUrl_v1')),
    CONSTRAINT "PluginWebhookRoute_routing_kind_check"
        CHECK ("routingKind" IN ('accountEndpoint', 'providerInstallation')),
    CONSTRAINT "PluginWebhookRoute_operator_route_check"
        CHECK (
            ("routingKind" = 'accountEndpoint'
                AND "operatorPluginId" IS NULL
                AND "operatorWebhookContributionId" IS NULL)
            OR
            ("routingKind" = 'providerInstallation'
                AND "operatorPluginId" IS NOT NULL
                AND "operatorWebhookContributionId" IS NOT NULL)
        ),
    CONSTRAINT "PluginWebhookRoute_policy_version_check" CHECK ("policyVersion" >= 0),
    CONSTRAINT "PluginWebhookRoute_distinct_credential_check"
        CHECK (
            "currentCredentialId" IS NULL
            OR "previousCredentialId" IS NULL
            OR "currentCredentialId" <> "previousCredentialId"
        ),
    CONSTRAINT "PluginWebhookRoute_accountEndpointId_fkey"
        FOREIGN KEY ("accountEndpointId") REFERENCES "PluginWebhookEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PluginWebhookRoute_currentCredentialId_fkey"
        FOREIGN KEY ("currentCredentialId") REFERENCES "PluginWebhookCredential" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PluginWebhookRoute_previousCredentialId_fkey"
        FOREIGN KEY ("previousCredentialId") REFERENCES "PluginWebhookCredential" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

INSERT INTO "new_PluginWebhookRoute" ("id", "opaqueRouteId", "verifierKind", "routingKind", "operatorPluginId", "operatorWebhookContributionId", "accountEndpointId", "enabled", "revokedAt", "policyVersion", "currentCredentialId", "previousCredentialId", "createdAt", "updatedAt")
SELECT "id", "opaqueRouteId", "verifierKind", "routingKind", "operatorPluginId", "operatorWebhookContributionId", "accountEndpointId", "enabled", "revokedAt", "policyVersion", "currentCredentialId", "previousCredentialId", "createdAt", "updatedAt" FROM "PluginWebhookRoute";

DROP TABLE "PluginWebhookRoute";
ALTER TABLE "new_PluginWebhookRoute" RENAME TO "PluginWebhookRoute";

CREATE UNIQUE INDEX "PluginWebhookRoute_opaqueRouteId_key"
ON "PluginWebhookRoute"("opaqueRouteId");
CREATE UNIQUE INDEX "plugin_webhook_route_operator_contribution_key"
ON "PluginWebhookRoute"("operatorPluginId", "operatorWebhookContributionId");
CREATE UNIQUE INDEX "PluginWebhookRoute_accountEndpointId_key"
ON "PluginWebhookRoute"("accountEndpointId");
CREATE UNIQUE INDEX "PluginWebhookRoute_currentCredentialId_key"
ON "PluginWebhookRoute"("currentCredentialId");
CREATE UNIQUE INDEX "PluginWebhookRoute_previousCredentialId_key"
ON "PluginWebhookRoute"("previousCredentialId");

ALTER TABLE "PluginWebhookEndpoint" ADD COLUMN "checkId" TEXT COLLATE BINARY NOT NULL DEFAULT '';
ALTER TABLE "PluginWebhookEndpoint" ADD COLUMN "lastAcceptedAt" DATETIME;

DROP INDEX "plugin_webhook_endpoint_account_contribution_source_key";
CREATE UNIQUE INDEX "plugin_webhook_endpoint_account_contribution_source_key"
ON "PluginWebhookEndpoint"("accountId", "pluginId", "webhookContributionId", "sourceInstanceId", "checkId");

PRAGMA foreign_keys=ON;
