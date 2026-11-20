CREATE TABLE "AccountPluginDeclarationBody" (
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "declarationDigest" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    PRIMARY KEY ("accountId", "pluginId", "declarationDigest"),
    CONSTRAINT "AccountPluginDeclarationBody_accountId_pluginId_fkey" FOREIGN KEY ("accountId", "pluginId")
        REFERENCES "AccountPluginIntent"("accountId", "pluginId") ON DELETE CASCADE ON UPDATE CASCADE
);

DROP INDEX "AccountSettingsSnapshot_accountId_version_idx";
DROP INDEX "AccountEncryptionTransitionCollectionStage_transition_page_idx";
DROP INDEX "AccountEncryptionTransitionAutomationStage_transition_page_idx";
DROP INDEX "PublicSessionShare_sessionId_idx";
DROP INDEX "PublicSessionShare_tokenHash_idx";
DROP INDEX "SessionSubagentCustody_scope_list_idx";
