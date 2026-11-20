CREATE TABLE `AccountPluginDeclarationBody` (
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `declarationDigest` VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `manifest` JSON NOT NULL,
    PRIMARY KEY (`accountId`, `pluginId`, `declarationDigest`),
    CONSTRAINT `AccountPluginDeclarationBody_accountId_pluginId_fkey` FOREIGN KEY (`accountId`, `pluginId`)
        REFERENCES `AccountPluginIntent`(`accountId`, `pluginId`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

DROP INDEX `AccountSettingsSnapshot_accountId_version_idx` ON `AccountSettingsSnapshot`;
DROP INDEX `AccountEncryptionTransitionCollectionStage_transition_page_idx` ON `AccountEncryptionTransitionCollectionStage`;
DROP INDEX `AccountEncryptionTransitionAutomationStage_transition_page_idx` ON `AccountEncryptionTransitionAutomationStage`;
DROP INDEX `PublicSessionShare_sessionId_idx` ON `PublicSessionShare`;
DROP INDEX `PublicSessionShare_tokenHash_idx` ON `PublicSessionShare`;
DROP INDEX `SessionSubagentCustody_scope_list_idx` ON `SessionSubagentCustody`;
