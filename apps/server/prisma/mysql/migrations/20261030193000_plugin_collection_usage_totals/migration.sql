ALTER TABLE `Account` ADD COLUMN `pluginCollectionRows` BIGINT NOT NULL DEFAULT 0;
ALTER TABLE `Account` ADD COLUMN `pluginCollectionEncodedBytes` BIGINT NOT NULL DEFAULT 0;
ALTER TABLE `PluginCollectionIndexState` ADD COLUMN `quotaPrefixCounts` JSON NOT NULL DEFAULT (JSON_OBJECT());

CREATE TABLE `PluginCollectionUsage` (
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `collectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `rows` BIGINT NOT NULL DEFAULT 0,
    `encodedBytes` BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT `PluginCollectionUsage_pkey` PRIMARY KEY (`accountId`, `pluginId`, `collectionId`),
    CONSTRAINT `PluginCollectionUsage_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginCollectionContractUsage` (
    `accountId` VARCHAR(191) NOT NULL,
    `contractId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `rows` BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT `PluginCollectionContractUsage_pkey` PRIMARY KEY (`accountId`, `contractId`),
    CONSTRAINT `PluginCollectionContractUsage_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionContractUsage_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `PluginCollectionContract`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Preserve the existing live-row lookup while letting readiness read the maximum revision from its index.
DROP INDEX `PluginCollectionRow_account_live_idx` ON `PluginCollectionRow`;
CREATE INDEX `PluginCollectionRow_account_live_idx` ON `PluginCollectionRow` (`accountId`, `pluginId`, `collectionId`, `deletedAt`, `revision`);

