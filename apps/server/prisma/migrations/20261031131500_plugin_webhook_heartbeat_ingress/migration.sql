-- Preserve the applied webhook ingress migration; extend its schema in place.
ALTER TABLE "PluginWebhookRoute"
    DROP CONSTRAINT "PluginWebhookRoute_verifier_kind_check",
    ADD CONSTRAINT "PluginWebhookRoute_verifier_kind_check"
        CHECK ("verifierKind" IN ('github_hmac_sha256_v1', 'capabilityUrl_v1'));

ALTER TABLE "PluginWebhookEndpoint"
    ADD COLUMN "checkId" VARCHAR(128) COLLATE "C" NOT NULL DEFAULT '',
    ADD COLUMN "lastAcceptedAt" TIMESTAMP(3);

DROP INDEX "plugin_webhook_endpoint_account_contribution_source_key";
CREATE UNIQUE INDEX "plugin_webhook_endpoint_account_contribution_source_key"
ON "PluginWebhookEndpoint"("accountId", "pluginId", "webhookContributionId", "sourceInstanceId", "checkId");
