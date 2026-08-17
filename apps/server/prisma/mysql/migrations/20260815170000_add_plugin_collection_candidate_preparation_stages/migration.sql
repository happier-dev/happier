-- Bounded non-authoritative target stages for DATA-EU7 candidate preparation.
-- Canonical Collection rows remain the only live reader/writer surface until
-- the Availability intent transaction promotes a complete exact stage set.
CREATE TABLE `PluginCollectionCandidatePreparationStage` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `collectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `rowId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `candidateIdentity` VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceRowDbId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceContractId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceSchemaVersion` INTEGER NOT NULL,
    `sourceContractDigest` VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceRevision` INTEGER NOT NULL,
    `targetContractId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `targetSchemaVersion` INTEGER NOT NULL,
    `targetContractDigest` VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `candidateReleaseVersion` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `candidateArtifactDigest` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `targetContentEnvelope` JSON NOT NULL,
    `targetProjection` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginCollectionCandidatePreparationStage_identity_key`(`accountId`, `candidateIdentity`, `sourceRowDbId`, `targetContractId`),
    INDEX `PluginCollectionCandidatePreparationStage_candidate_idx`(`accountId`, `pluginId`),
    INDEX `PluginCollectionCandidatePreparationStage_source_idx`(`accountId`, `sourceRowDbId`),
    CONSTRAINT `PCCPS_account_fk`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PCCPS_source_row_fk`
        FOREIGN KEY (`sourceRowDbId`) REFERENCES `PluginCollectionRow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PCCPS_source_contract_fk`
        FOREIGN KEY (`sourceContractId`) REFERENCES `PluginCollectionContract`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `PCCPS_target_contract_fk`
        FOREIGN KEY (`targetContractId`) REFERENCES `PluginCollectionContract`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `PCCPS_currentness_ck`
        CHECK (`sourceSchemaVersion` >= 1 AND `targetSchemaVersion` >= 1 AND `sourceRevision` >= 0),
    CONSTRAINT `PCCPS_candidate_identity_ck`
        CHECK (`candidateIdentity` REGEXP '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT `PCCPS_source_digest_ck`
        CHECK (`sourceContractDigest` REGEXP '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT `PCCPS_target_digest_ck`
        CHECK (`targetContractDigest` REGEXP '^[A-Za-z0-9_-]{43}$')
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
