SELECT happier_prepare_qualified_connected_accounts_v4();

CREATE TABLE "_QualifiedMemberBackup" AS SELECT * FROM "ConnectedServiceAuthGroupMember";
CREATE TABLE "_QualifiedUsageBackup" AS SELECT * FROM "ConnectedServiceUsageSource";
DROP TABLE "ConnectedServiceAuthGroupMember";
DROP TABLE "ConnectedServiceUsageSource";

CREATE TABLE "new_ServiceAccountToken" (
    "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "vendor" TEXT,
    "token" BLOB NOT NULL, "metadata" JSONB, "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
    "profileId" TEXT, "expiresAt" DATETIME, "refreshLeaseOwnerMachineId" TEXT,
    "refreshLeaseExpiresAt" DATETIME, "service_plugin_id" TEXT NOT NULL,
    "service_local_id" TEXT NOT NULL, "qualified_service_digest" TEXT NOT NULL,
    "connected_account_id" TEXT NOT NULL, "qualified_identity_digest" TEXT NOT NULL,
    "authentication_mode_id" TEXT NOT NULL, "configuration_revision" TEXT,
    "configuration_content" BLOB CHECK (("configuration_revision" IS NULL) = ("configuration_content" IS NULL)),
    CONSTRAINT "ServiceAccountToken_accountId_fkey" FOREIGN KEY ("accountId")
      REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ServiceAccountToken" SELECT
    "id","accountId","vendor","token","metadata","lastUsedAt","createdAt","updatedAt",
    "profileId","expiresAt","refreshLeaseOwnerMachineId","refreshLeaseExpiresAt",
    "service_plugin_id","service_local_id","qualified_service_digest","connected_account_id",
    "qualified_identity_digest","authentication_mode_id","configuration_revision","configuration_content"
FROM "ServiceAccountToken";
DROP TABLE "ServiceAccountToken";
ALTER TABLE "new_ServiceAccountToken" RENAME TO "ServiceAccountToken";
CREATE INDEX "ServiceAccountToken_accountId_idx" ON "ServiceAccountToken"("accountId");
CREATE UNIQUE INDEX "ServiceAccountToken_accountId_vendor_profileId_key" ON "ServiceAccountToken"("accountId","vendor","profileId");
CREATE UNIQUE INDEX "sat_qualified_identity_key" ON "ServiceAccountToken"("accountId","qualified_identity_digest");
CREATE UNIQUE INDEX "sat_qualified_credential_fkey" ON "ServiceAccountToken"("accountId","qualified_service_digest","qualified_identity_digest","id");

CREATE TABLE "new_ConnectedServiceAuthGroup" (
    "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "vendor" TEXT,
    "service_plugin_id" TEXT NOT NULL, "service_local_id" TEXT NOT NULL,
    "qualified_service_digest" TEXT NOT NULL, "qualified_group_digest" TEXT NOT NULL,
    "groupId" TEXT NOT NULL, "displayName" TEXT, "policyJson" TEXT NOT NULL,
    "activeProfileId" TEXT, "active_connected_account_id" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0, "runtimeStateRevision" INTEGER NOT NULL DEFAULT 0,
    "stateJson" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConnectedServiceAuthGroup_accountId_fkey" FOREIGN KEY ("accountId")
      REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConnectedServiceAuthGroup" SELECT
    "id","accountId","vendor","service_plugin_id","service_local_id","qualified_service_digest",
    "qualified_group_digest","groupId","displayName","policyJson","activeProfileId",
    "active_connected_account_id","generation","runtimeStateRevision","stateJson","createdAt","updatedAt"
FROM "ConnectedServiceAuthGroup";
DROP TABLE "ConnectedServiceAuthGroup";
ALTER TABLE "new_ConnectedServiceAuthGroup" RENAME TO "ConnectedServiceAuthGroup";
CREATE UNIQUE INDEX "ConnectedServiceAuthGroup_accountId_vendor_groupId_key" ON "ConnectedServiceAuthGroup"("accountId","vendor","groupId");
CREATE UNIQUE INDEX "csag_qualified_group_key" ON "ConnectedServiceAuthGroup"("accountId","qualified_group_digest");
CREATE UNIQUE INDEX "csag_qualified_group_fkey" ON "ConnectedServiceAuthGroup"("accountId","qualified_service_digest","qualified_group_digest","id");
CREATE INDEX "ConnectedServiceAuthGroup_accountId_vendor_idx" ON "ConnectedServiceAuthGroup"("accountId","vendor");

CREATE TABLE "ConnectedServiceAuthGroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY, "groupDbId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL, "qualified_service_digest" TEXT NOT NULL,
    "qualified_group_digest" TEXT NOT NULL, "qualified_identity_digest" TEXT NOT NULL,
    "vendor" TEXT, "groupId" TEXT, "profileId" TEXT, "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true, "stateJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "csagm_group_fkey" FOREIGN KEY ("accountId","qualified_service_digest","qualified_group_digest","groupDbId")
      REFERENCES "ConnectedServiceAuthGroup" ("accountId","qualified_service_digest","qualified_group_digest","id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "csagm_credential_fkey" FOREIGN KEY ("accountId","qualified_service_digest","qualified_identity_digest","credential_id")
      REFERENCES "ServiceAccountToken" ("accountId","qualified_service_digest","qualified_identity_digest","id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "ConnectedServiceAuthGroupMember" SELECT
    "id","groupDbId","accountId","credential_id","qualified_service_digest","qualified_group_digest",
    "qualified_identity_digest","vendor","groupId","profileId","priority","enabled","stateJson","createdAt","updatedAt"
FROM "_QualifiedMemberBackup";
DROP TABLE "_QualifiedMemberBackup";
CREATE UNIQUE INDEX "csagm_account_vendor_group_profile_key" ON "ConnectedServiceAuthGroupMember"("accountId","vendor","groupId","profileId");
CREATE UNIQUE INDEX "csagm_group_credential_key" ON "ConnectedServiceAuthGroupMember"("groupDbId","credential_id");
CREATE INDEX "ConnectedServiceAuthGroupMember_groupDbId_idx" ON "ConnectedServiceAuthGroupMember"("groupDbId");
CREATE INDEX "ConnectedServiceAuthGroupMember_credential_id_idx" ON "ConnectedServiceAuthGroupMember"("credential_id");

CREATE TABLE "ConnectedServiceUsageSource" (
    "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "serviceId" TEXT, "profileId" TEXT,
    "service_plugin_id" TEXT NOT NULL, "service_local_id" TEXT NOT NULL,
    "qualified_service_digest" TEXT NOT NULL, "connected_account_id" TEXT NOT NULL,
    "qualified_identity_digest" TEXT NOT NULL, "credential_id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL, "providerAccountUsageRecordId" TEXT NOT NULL,
    "bindingKind" TEXT NOT NULL, "groupId" TEXT, "groupGeneration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "csus_record_fkey" FOREIGN KEY ("accountId","providerAccountUsageRecordId")
      REFERENCES "ProviderAccountUsageRecord" ("accountId","recordId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "csus_credential_fkey" FOREIGN KEY ("accountId","qualified_service_digest","qualified_identity_digest","credential_id")
      REFERENCES "ServiceAccountToken" ("accountId","qualified_service_digest","qualified_identity_digest","id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "ConnectedServiceUsageSource" SELECT
    "id","accountId","serviceId","profileId","service_plugin_id","service_local_id",
    "qualified_service_digest","connected_account_id","qualified_identity_digest","credential_id",
    "sourceKey","providerAccountUsageRecordId","bindingKind","groupId","groupGeneration","createdAt","updatedAt"
FROM "_QualifiedUsageBackup";
DROP TABLE "_QualifiedUsageBackup";
CREATE UNIQUE INDEX "ConnectedServiceUsageSource_accountId_sourceKey_key" ON "ConnectedServiceUsageSource"("accountId","sourceKey");
CREATE INDEX "csus_account_service_profile_idx" ON "ConnectedServiceUsageSource"("accountId","serviceId","profileId");
CREATE INDEX "csus_record_idx" ON "ConnectedServiceUsageSource"("accountId","providerAccountUsageRecordId");

CREATE TEMPORARY TABLE "_QualifiedForeignKeyGuard" (
    "foreignKeyViolationRows" INTEGER NOT NULL CHECK ("foreignKeyViolationRows" = 0)
);
INSERT INTO "_QualifiedForeignKeyGuard" SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE "_QualifiedForeignKeyGuard";
