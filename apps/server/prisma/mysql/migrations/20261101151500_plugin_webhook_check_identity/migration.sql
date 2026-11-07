-- Prisma migrate diff endpoint delta, expanded to backfill before contracting identity.
ALTER TABLE `PluginWebhookEndpoint` ADD COLUMN `checkIdDigest` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;
UPDATE `PluginWebhookEndpoint`
SET `checkIdDigest` = CASE WHEN `checkId` = '' THEN ''
    ELSE LOWER(SHA2(CONVERT(JSON_QUOTE(`checkId`) USING utf8mb4), 256)) END;
ALTER TABLE `PluginWebhookEndpoint` MODIFY `checkIdDigest` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '';
DROP INDEX `plugin_webhook_endpoint_account_contribution_source_key` ON `PluginWebhookEndpoint`;
ALTER TABLE `PluginWebhookEndpoint` MODIFY `checkId` VARCHAR(2000) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '';
CREATE UNIQUE INDEX `plugin_webhook_endpoint_account_contribution_source_key`
ON `PluginWebhookEndpoint`(`accountId`, `pluginId`, `webhookContributionId`, `sourceInstanceId`, `checkIdDigest`);
