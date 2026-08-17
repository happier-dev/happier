ALTER TABLE `SessionMessage`
    ADD COLUMN `inputAdmissionReceipt` JSON NULL,
    ADD COLUMN `requestEqualityEvidenceV1` JSON NULL;

ALTER TABLE `SessionPendingMessage`
    ADD COLUMN `inputAdmissionReceipt` JSON NULL,
    ADD COLUMN `requestEqualityEvidenceV1` JSON NULL;

ALTER TABLE `Machine`
    ADD COLUMN `operationProtocolCapabilities` JSON NULL,
    ADD COLUMN `operationProtocolCapabilitiesRevision` INTEGER NULL;

CREATE TABLE `PluginCollectionContract` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `collectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `schemaVersion` INTEGER NOT NULL,
    `contractDigest` VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `normalizedSchema` JSON NOT NULL,
    `indexes` JSON NOT NULL,
    `relations` JSON NOT NULL,
    `privacyProjection` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginCollectionContract_identity_schema_key`(`pluginId`, `collectionId`, `schemaVersion`),
    UNIQUE INDEX `PluginCollectionContract_identity_digest_key`(`pluginId`, `collectionId`, `contractDigest`),
    INDEX `PluginCollectionContract_identity_idx`(`pluginId`, `collectionId`),
    CONSTRAINT `PluginCollectionContract_contract_digest_check`
        CHECK (`contractDigest` REGEXP '^[A-Za-z0-9_-]{43}$')
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginCollectionRow` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `collectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `rowId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `schemaVersion` INTEGER NOT NULL,
    `revision` INTEGER NOT NULL,
    `contractId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `contractDigest` VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `contentEnvelope` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginCollectionRow_account_identity_key`(`accountId`, `pluginId`, `collectionId`, `rowId`),
    INDEX `PluginCollectionRow_account_live_idx`(`accountId`, `pluginId`, `collectionId`, `deletedAt`),
    INDEX `PluginCollectionRow_account_contract_idx`(`accountId`, `pluginId`, `collectionId`, `contractDigest`),
    CONSTRAINT `PluginCollectionRow_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionRow_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `PluginCollectionContract`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionRow_contract_digest_check`
        CHECK (`contractDigest` REGEXP '^[A-Za-z0-9_-]{43}$')
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginCollectionProjection` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `rowDbId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `collectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `rowId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `fieldId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `typedEncodedValue` LONGTEXT NOT NULL,
    `rowRevision` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginCollectionProjection_row_field_key`(`rowDbId`, `fieldId`),
    INDEX `PluginCollectionProjection_field_idx`(`accountId`, `pluginId`, `collectionId`, `fieldId`),
    INDEX `PluginCollectionProjection_row_idx`(`accountId`, `pluginId`, `collectionId`, `rowId`),
    CONSTRAINT `PluginCollectionProjection_rowDbId_fkey` FOREIGN KEY (`rowDbId`) REFERENCES `PluginCollectionRow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginCollectionIndexState` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `collectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `indexId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `contractId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `contractDigest` VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `buildState` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `indexedThroughRevision` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginCollectionIndexState_identity_key`(`accountId`, `pluginId`, `collectionId`, `indexId`, `contractDigest`),
    INDEX `PluginCollectionIndexState_build_idx`(`accountId`, `pluginId`, `collectionId`, `buildState`),
    CONSTRAINT `PluginCollectionIndexState_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionIndexState_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `PluginCollectionContract`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionIndexState_contract_digest_check`
        CHECK (`contractDigest` REGEXP '^[A-Za-z0-9_-]{43}$')
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginCollectionIndexEntry` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `indexStateId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `encodedSortKey` VARBINARY(2318) NOT NULL,
    `rowId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `rowRevision` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginCollectionIndexEntry_sort_key`(`indexStateId`, `encodedSortKey`),
    INDEX `PluginCollectionIndexEntry_row_idx`(`indexStateId`, `rowId`),
    CONSTRAINT `PluginCollectionIndexEntry_indexStateId_fkey` FOREIGN KEY (`indexStateId`) REFERENCES `PluginCollectionIndexState`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginCollectionRelation` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sourceRowDbId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourcePluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceCollectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceRowId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `relationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `targetKind` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `targetPluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetCollectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetRowId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `sourceRevision` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`),
    INDEX `PluginCollectionRelation_source_idx`(`accountId`, `sourcePluginId`, `sourceCollectionId`, `sourceRowId`, `deletedAt`),
    INDEX `PluginCollectionRelation_target_idx`(`accountId`, `targetKind`, `targetPluginId`, `targetCollectionId`, `targetRowId`, `deletedAt`),
    CONSTRAINT `PluginCollectionRelation_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionRelation_sourceRowDbId_fkey` FOREIGN KEY (`sourceRowDbId`) REFERENCES `PluginCollectionRow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Machine`
    ADD COLUMN `pluginMaterializationRevision` BIGINT NULL;

CREATE TABLE `AccountPluginIntent` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `desiredVersion` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `offlineUiHosting` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'disabled',
    `writableCollections` JSON NOT NULL,
    `revision` BIGINT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `AccountPluginIntent_accountId_pluginId_key`(`accountId`, `pluginId`),
    CONSTRAINT `AccountPluginIntent_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AccountPluginRelease` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `version` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `archiveDigestSha256` VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `normalizedManifest` JSON NOT NULL,
    `collectionContracts` JSON NOT NULL,
    `uiSlots` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `AccountPluginRelease_accountId_pluginId_version_key`(`accountId`, `pluginId`, `version`),
    CONSTRAINT `AccountPluginRelease_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AccountPluginUiArtifact` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `releaseId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `contributionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `tier` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `platform` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `artifactId` VARCHAR(191) NOT NULL,
    `artifactDigest` VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `compatibility` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `AccountPluginUiArtifact_release_slot_key`(`releaseId`, `contributionId`, `tier`, `platform`),
    UNIQUE INDEX `AccountPluginUiArtifact_artifactId_key`(`artifactId`),
    CONSTRAINT `AccountPluginUiArtifact_releaseId_fkey` FOREIGN KEY (`releaseId`) REFERENCES `AccountPluginRelease`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `AccountPluginUiArtifact_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `Artifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginMachineMaterialization` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `serverIdentityId` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `materializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `version` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceClass` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `portableRelease` BOOLEAN NOT NULL,
    `archiveDigestSha256` VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin,
    `uiArtifacts` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL,
    `trustState` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginMachineMaterialization_machineId_materializationId_key`(`machineId`, `materializationId`),
    INDEX `PluginMachineMaterialization_account_server_machine_idx`(`accountId`, `serverIdentityId`, `machineId`),
    INDEX `PluginMachineMaterialization_accountId_pluginId_idx`(`accountId`, `pluginId`),
    CONSTRAINT `PluginMachineMaterialization_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginMachineMaterialization_accountId_machineId_fkey` FOREIGN KEY (`accountId`, `machineId`) REFERENCES `Machine`(`accountId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
