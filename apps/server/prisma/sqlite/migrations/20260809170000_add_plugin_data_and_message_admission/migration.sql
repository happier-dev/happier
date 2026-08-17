ALTER TABLE "SessionMessage" ADD COLUMN "inputAdmissionReceipt" JSONB;
ALTER TABLE "SessionMessage" ADD COLUMN "requestEqualityEvidenceV1" JSONB;
ALTER TABLE "SessionPendingMessage" ADD COLUMN "inputAdmissionReceipt" JSONB;
ALTER TABLE "SessionPendingMessage" ADD COLUMN "requestEqualityEvidenceV1" JSONB;
ALTER TABLE "Machine" ADD COLUMN "operationProtocolCapabilities" JSONB;
ALTER TABLE "Machine" ADD COLUMN "operationProtocolCapabilitiesRevision" INTEGER;

CREATE TABLE "PluginCollectionContract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pluginId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "contractDigest" TEXT NOT NULL CHECK (length("contractDigest") = 43 AND "contractDigest" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "normalizedSchema" JSONB NOT NULL,
    "indexes" JSONB NOT NULL,
    "relations" JSONB NOT NULL,
    "privacyProjection" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PluginCollectionRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "contractId" TEXT NOT NULL,
    "contractDigest" TEXT NOT NULL CHECK (length("contractDigest") = 43 AND "contractDigest" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "contentEnvelope" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "PluginCollectionRow_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionRow_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PluginCollectionContract" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PluginCollectionProjection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rowDbId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "typedEncodedValue" TEXT NOT NULL,
    "rowRevision" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginCollectionProjection_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PluginCollectionIndexState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "indexId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "contractDigest" TEXT NOT NULL CHECK (length("contractDigest") = 43 AND "contractDigest" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "buildState" TEXT NOT NULL,
    "indexedThroughRevision" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginCollectionIndexState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionIndexState_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PluginCollectionContract" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PluginCollectionIndexEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "indexStateId" TEXT NOT NULL,
    "encodedSortKey" BLOB NOT NULL,
    "rowId" TEXT NOT NULL,
    "rowRevision" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PluginCollectionIndexEntry_indexStateId_fkey" FOREIGN KEY ("indexStateId") REFERENCES "PluginCollectionIndexState" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PluginCollectionRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sourceRowDbId" TEXT NOT NULL,
    "sourcePluginId" TEXT NOT NULL,
    "sourceCollectionId" TEXT NOT NULL,
    "sourceRowId" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetPluginId" TEXT,
    "targetCollectionId" TEXT,
    "targetRowId" TEXT,
    "sourceRevision" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "PluginCollectionRelation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginCollectionRelation_sourceRowDbId_fkey" FOREIGN KEY ("sourceRowDbId") REFERENCES "PluginCollectionRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PluginCollectionContract_identity_schema_key"
ON "PluginCollectionContract"("pluginId", "collectionId", "schemaVersion");
CREATE UNIQUE INDEX "PluginCollectionContract_identity_digest_key"
ON "PluginCollectionContract"("pluginId", "collectionId", "contractDigest");
CREATE INDEX "PluginCollectionContract_identity_idx"
ON "PluginCollectionContract"("pluginId", "collectionId");

CREATE UNIQUE INDEX "PluginCollectionRow_account_identity_key"
ON "PluginCollectionRow"("accountId", "pluginId", "collectionId", "rowId");
CREATE INDEX "PluginCollectionRow_account_live_idx"
ON "PluginCollectionRow"("accountId", "pluginId", "collectionId", "deletedAt");
CREATE INDEX "PluginCollectionRow_account_contract_idx"
ON "PluginCollectionRow"("accountId", "pluginId", "collectionId", "contractDigest");

CREATE UNIQUE INDEX "PluginCollectionProjection_row_field_key"
ON "PluginCollectionProjection"("rowDbId", "fieldId");
CREATE INDEX "PluginCollectionProjection_field_idx"
ON "PluginCollectionProjection"("accountId", "pluginId", "collectionId", "fieldId");
CREATE INDEX "PluginCollectionProjection_row_idx"
ON "PluginCollectionProjection"("accountId", "pluginId", "collectionId", "rowId");

CREATE UNIQUE INDEX "PluginCollectionIndexState_identity_key"
ON "PluginCollectionIndexState"("accountId", "pluginId", "collectionId", "indexId", "contractDigest");
CREATE INDEX "PluginCollectionIndexState_build_idx"
ON "PluginCollectionIndexState"("accountId", "pluginId", "collectionId", "buildState");

CREATE UNIQUE INDEX "PluginCollectionIndexEntry_sort_key"
ON "PluginCollectionIndexEntry"("indexStateId", "encodedSortKey");
CREATE INDEX "PluginCollectionIndexEntry_row_idx"
ON "PluginCollectionIndexEntry"("indexStateId", "rowId");

CREATE INDEX "PluginCollectionRelation_source_idx"
ON "PluginCollectionRelation"("accountId", "sourcePluginId", "sourceCollectionId", "sourceRowId", "deletedAt");
CREATE INDEX "PluginCollectionRelation_target_idx"
ON "PluginCollectionRelation"("accountId", "targetKind", "targetPluginId", "targetCollectionId", "targetRowId", "deletedAt");

ALTER TABLE "Machine" ADD COLUMN "pluginMaterializationRevision" INTEGER;

CREATE TABLE "AccountPluginIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "desiredVersion" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "offlineUiHosting" TEXT NOT NULL DEFAULT 'disabled',
    "writableCollections" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountPluginIntent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AccountPluginRelease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "archiveDigestSha256" TEXT NOT NULL,
    "normalizedManifest" JSONB NOT NULL,
    "collectionContracts" JSONB NOT NULL,
    "uiSlots" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountPluginRelease_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AccountPluginUiArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "releaseId" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "artifactDigest" TEXT NOT NULL,
    "compatibility" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountPluginUiArtifact_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "AccountPluginRelease" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AccountPluginUiArtifact_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PluginMachineMaterialization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "serverIdentityId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "materializationId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sourceClass" TEXT NOT NULL,
    "portableRelease" BOOLEAN NOT NULL,
    "archiveDigestSha256" TEXT,
    "uiArtifacts" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "trustState" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginMachineMaterialization_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginMachineMaterialization_accountId_machineId_fkey" FOREIGN KEY ("accountId", "machineId") REFERENCES "Machine" ("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AccountPluginIntent_accountId_pluginId_key"
ON "AccountPluginIntent"("accountId", "pluginId");
CREATE UNIQUE INDEX "AccountPluginRelease_accountId_pluginId_version_key"
ON "AccountPluginRelease"("accountId", "pluginId", "version");
CREATE UNIQUE INDEX "AccountPluginUiArtifact_release_slot_key"
ON "AccountPluginUiArtifact"("releaseId", "contributionId", "tier", "platform");
CREATE UNIQUE INDEX "AccountPluginUiArtifact_artifactId_key"
ON "AccountPluginUiArtifact"("artifactId");
CREATE UNIQUE INDEX "PluginMachineMaterialization_machineId_materializationId_key"
ON "PluginMachineMaterialization"("machineId", "materializationId");
CREATE INDEX "PluginMachineMaterialization_account_server_machine_idx"
ON "PluginMachineMaterialization"("accountId", "serverIdentityId", "machineId");
CREATE INDEX "PluginMachineMaterialization_accountId_pluginId_idx"
ON "PluginMachineMaterialization"("accountId", "pluginId");
