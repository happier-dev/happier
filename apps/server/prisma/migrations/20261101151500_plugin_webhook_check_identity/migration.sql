-- Prisma migrate diff endpoint delta, expanded to backfill before contracting identity.
BEGIN;
ALTER TABLE "PluginWebhookEndpoint" ADD COLUMN "checkIdDigest" TEXT;
UPDATE "PluginWebhookEndpoint"
SET "checkIdDigest" = CASE WHEN "checkId" = '' THEN ''
    ELSE encode(sha256(convert_to(to_json("checkId")::text, 'UTF8')), 'hex') END;
ALTER TABLE "PluginWebhookEndpoint" ALTER COLUMN "checkIdDigest" SET NOT NULL,
    ALTER COLUMN "checkIdDigest" SET DEFAULT '';
DROP INDEX "plugin_webhook_endpoint_account_contribution_source_key";
ALTER TABLE "PluginWebhookEndpoint" ALTER COLUMN "checkId" TYPE TEXT COLLATE "C";
CREATE UNIQUE INDEX "plugin_webhook_endpoint_account_contribution_source_key"
ON "PluginWebhookEndpoint"("accountId", "pluginId", "webhookContributionId", "sourceInstanceId", "checkIdDigest");
COMMIT;
