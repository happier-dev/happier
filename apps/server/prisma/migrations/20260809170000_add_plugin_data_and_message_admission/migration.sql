ALTER TABLE "SessionMessage"
    ADD COLUMN "inputAdmissionReceipt" JSONB,
    ADD COLUMN "requestEqualityEvidenceV1" JSONB;

ALTER TABLE "SessionPendingMessage"
    ADD COLUMN "inputAdmissionReceipt" JSONB,
    ADD COLUMN "requestEqualityEvidenceV1" JSONB;

ALTER TABLE "Machine"
    ADD COLUMN "operationProtocolCapabilities" JSONB,
    ADD COLUMN "operationProtocolCapabilitiesRevision" INTEGER;

CREATE TABLE "PluginCollectionContract" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT COLLATE "C" NOT NULL,
    "collectionId" TEXT COLLATE "C" NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "contractDigest" VARCHAR(43) COLLATE "C" NOT NULL,
    "normalizedSchema" JSONB NOT NULL,
    "indexes" JSONB NOT NULL,
    "relations" JSONB NOT NULL,
    "privacyProjection" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginCollectionContract_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PluginCollectionContract_contract_digest_check"
        CHECK (char_length("contractDigest") = 43 AND "contractDigest" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE TABLE "PluginCollectionRow" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT COLLATE "C" NOT NULL,
    "collectionId" TEXT COLLATE "C" NOT NULL,
    "rowId" TEXT COLLATE "C" NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "contractId" TEXT NOT NULL,
    "contractDigest" VARCHAR(43) COLLATE "C" NOT NULL,
    "contentEnvelope" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PluginCollectionRow_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PluginCollectionRow_contract_digest_check"
        CHECK (char_length("contractDigest") = 43 AND "contractDigest" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE TABLE "PluginCollectionProjection" (
    "id" TEXT NOT NULL,
    "rowDbId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT COLLATE "C" NOT NULL,
    "collectionId" TEXT COLLATE "C" NOT NULL,
    "rowId" TEXT COLLATE "C" NOT NULL,
    "fieldId" TEXT COLLATE "C" NOT NULL,
    "typedEncodedValue" TEXT NOT NULL,
    "rowRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginCollectionProjection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginCollectionIndexState" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT COLLATE "C" NOT NULL,
    "collectionId" TEXT COLLATE "C" NOT NULL,
    "indexId" TEXT COLLATE "C" NOT NULL,
    "contractId" TEXT NOT NULL,
    "contractDigest" VARCHAR(43) COLLATE "C" NOT NULL,
    "buildState" TEXT NOT NULL,
    "indexedThroughRevision" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginCollectionIndexState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PluginCollectionIndexState_contract_digest_check"
        CHECK (char_length("contractDigest") = 43 AND "contractDigest" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE TABLE "PluginCollectionIndexEntry" (
    "id" TEXT NOT NULL,
    "indexStateId" TEXT NOT NULL,
    "encodedSortKey" BYTEA NOT NULL,
    "rowId" TEXT COLLATE "C" NOT NULL,
    "rowRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginCollectionIndexEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginCollectionRelation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceRowDbId" TEXT NOT NULL,
    "sourcePluginId" TEXT COLLATE "C" NOT NULL,
    "sourceCollectionId" TEXT COLLATE "C" NOT NULL,
    "sourceRowId" TEXT COLLATE "C" NOT NULL,
    "relationId" TEXT COLLATE "C" NOT NULL,
    "targetKind" TEXT COLLATE "C" NOT NULL,
    "targetPluginId" TEXT COLLATE "C",
    "targetCollectionId" TEXT COLLATE "C",
    "targetRowId" TEXT COLLATE "C",
    "sourceRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PluginCollectionRelation_pkey" PRIMARY KEY ("id")
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

ALTER TABLE "PluginCollectionRow"
    ADD CONSTRAINT "PluginCollectionRow_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginCollectionRow"
    ADD CONSTRAINT "PluginCollectionRow_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "PluginCollectionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginCollectionProjection"
    ADD CONSTRAINT "PluginCollectionProjection_rowDbId_fkey"
    FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginCollectionIndexState"
    ADD CONSTRAINT "PluginCollectionIndexState_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginCollectionIndexState"
    ADD CONSTRAINT "PluginCollectionIndexState_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "PluginCollectionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginCollectionIndexEntry"
    ADD CONSTRAINT "PluginCollectionIndexEntry_indexStateId_fkey"
    FOREIGN KEY ("indexStateId") REFERENCES "PluginCollectionIndexState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginCollectionRelation"
    ADD CONSTRAINT "PluginCollectionRelation_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginCollectionRelation"
    ADD CONSTRAINT "PluginCollectionRelation_sourceRowDbId_fkey"
    FOREIGN KEY ("sourceRowDbId") REFERENCES "PluginCollectionRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Machine"
    ADD COLUMN "pluginMaterializationRevision" BIGINT;

CREATE TABLE "AccountPluginIntent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" VARCHAR(256) COLLATE "C" NOT NULL,
    "desiredVersion" VARCHAR(256) COLLATE "C",
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "offlineUiHosting" TEXT COLLATE "C" NOT NULL DEFAULT 'disabled',
    "writableCollections" JSONB NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountPluginIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountPluginRelease" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" VARCHAR(256) COLLATE "C" NOT NULL,
    "version" VARCHAR(256) COLLATE "C" NOT NULL,
    "archiveDigestSha256" VARCHAR(71) COLLATE "C" NOT NULL,
    "normalizedManifest" JSONB NOT NULL,
    "collectionContracts" JSONB NOT NULL,
    "uiSlots" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountPluginRelease_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountPluginUiArtifact" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "contributionId" VARCHAR(256) COLLATE "C" NOT NULL,
    "tier" VARCHAR(32) COLLATE "C" NOT NULL,
    "platform" VARCHAR(16) COLLATE "C" NOT NULL,
    "artifactId" TEXT NOT NULL,
    "artifactDigest" VARCHAR(71) COLLATE "C" NOT NULL,
    "compatibility" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountPluginUiArtifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginMachineMaterialization" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "serverIdentityId" VARCHAR(64) COLLATE "C" NOT NULL,
    "machineId" TEXT NOT NULL,
    "materializationId" VARCHAR(256) COLLATE "C" NOT NULL,
    "pluginId" VARCHAR(256) COLLATE "C" NOT NULL,
    "version" VARCHAR(256) COLLATE "C" NOT NULL,
    "sourceClass" VARCHAR(32) COLLATE "C" NOT NULL,
    "portableRelease" BOOLEAN NOT NULL,
    "archiveDigestSha256" VARCHAR(71) COLLATE "C",
    "uiArtifacts" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "trustState" VARCHAR(32) COLLATE "C" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginMachineMaterialization_pkey" PRIMARY KEY ("id")
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

ALTER TABLE "AccountPluginIntent"
    ADD CONSTRAINT "AccountPluginIntent_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountPluginRelease"
    ADD CONSTRAINT "AccountPluginRelease_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountPluginUiArtifact"
    ADD CONSTRAINT "AccountPluginUiArtifact_releaseId_fkey"
    FOREIGN KEY ("releaseId") REFERENCES "AccountPluginRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountPluginUiArtifact"
    ADD CONSTRAINT "AccountPluginUiArtifact_artifactId_fkey"
    FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginMachineMaterialization"
    ADD CONSTRAINT "PluginMachineMaterialization_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginMachineMaterialization"
    ADD CONSTRAINT "PluginMachineMaterialization_accountId_machineId_fkey"
    FOREIGN KEY ("accountId", "machineId") REFERENCES "Machine"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
