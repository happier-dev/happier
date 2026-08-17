CREATE TABLE `AccountEncryptionTransition` (
    `id` VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `fromEncryptionMode` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `toEncryptionMode` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceAccountVersion` INTEGER NOT NULL,
    `sourceSettingsVersion` INTEGER NOT NULL,
    `sourceSigningKeyFingerprint` VARCHAR(49) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `sourceContentKeyFingerprint` VARCHAR(49) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetSigningKeyFingerprint` VARCHAR(49) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetContentKeyFingerprint` VARCHAR(49) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetAccountPublicKey` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetContentPublicKey` BLOB NULL,
    `targetContentPublicKeySig` BLOB NULL,
    `status` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `activeAccountId` VARCHAR(191) NULL,
    `preparedAt` DATETIME(3) NOT NULL,
    `authorizedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `activatedAt` DATETIME(3) NULL,
    `activatedAccountVersion` INTEGER NULL,
    `activatedAccountUpdatedAt` DATETIME(3) NULL,
    `activatedAccountCursor` INTEGER NULL,
    `cancelledAt` DATETIME(3) NULL,
    `expiredAt` DATETIME(3) NULL,
    `censusParticipantCount` INTEGER NOT NULL DEFAULT 0,
    `censusSourceBytes` BIGINT NOT NULL DEFAULT 0,
    `censusTargetBytes` BIGINT NOT NULL DEFAULT 0,
    `stagedParticipantCount` INTEGER NOT NULL DEFAULT 0,
    `stagedSourceBytes` BIGINT NOT NULL DEFAULT 0,
    `stagedTargetBytes` BIGINT NOT NULL DEFAULT 0,
    `reservedCapacityBytes` BIGINT NOT NULL DEFAULT 0,
    `measuredParticipantLimit` INTEGER NULL,
    `measuredEncodedByteLimit` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `AccountEncryptionTransition_activeAccountId_key`(`activeAccountId`),
    INDEX `AccountEncryptionTransition_account_status_expiry_idx`(`accountId`, `status`, `expiresAt`),
    CONSTRAINT `AccountEncryptionTransition_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `AccountEncryptionTransition_status_check`
        CHECK (`status` IN ('preparing', 'authorized', 'activated', 'cancelled', 'expired')),
    CONSTRAINT `AccountEncryptionTransition_mode_check`
        CHECK (`fromEncryptionMode` IN ('plain', 'e2ee') AND `toEncryptionMode` IN ('plain', 'e2ee')),
    -- MySQL rejects a CHECK that reads `accountId` because that column has a
    -- cascading FK action. The canonical transition coordinator is the sole
    -- writer of both fields; retain the provider-enforceable lifecycle/null
    -- invariant here rather than making this migration undeployable.
    CONSTRAINT `AccountEncryptionTransition_active_account_check`
        CHECK (
            (`status` IN ('preparing', 'authorized') AND `activeAccountId` IS NOT NULL)
            OR (`status` IN ('activated', 'cancelled', 'expired') AND `activeAccountId` IS NULL)
        ),
    CONSTRAINT `AccountEncryptionTransition_currentness_check`
        CHECK (`sourceAccountVersion` >= 0 AND `sourceSettingsVersion` >= 0),
    CONSTRAINT `AccountEncryptionTransition_activation_result_check`
        CHECK (
            (`status` = 'activated'
                AND `activatedAt` IS NOT NULL
                AND `activatedAccountVersion` IS NOT NULL
                AND `activatedAccountUpdatedAt` IS NOT NULL
                AND `activatedAccountCursor` IS NOT NULL
                AND `activatedAccountVersion` >= 0
                AND `activatedAccountCursor` >= 0)
            OR
            (`status` <> 'activated'
                AND `activatedAccountVersion` IS NULL
                AND `activatedAccountUpdatedAt` IS NULL
                AND `activatedAccountCursor` IS NULL)
        ),
    CONSTRAINT `AccountEncryptionTransition_capacity_check`
        CHECK (
            `censusParticipantCount` >= 0
            AND `censusSourceBytes` >= 0
            AND `censusTargetBytes` >= 0
            AND `stagedParticipantCount` >= 0
            AND `stagedSourceBytes` >= 0
            AND `stagedTargetBytes` >= 0
            AND `reservedCapacityBytes` >= 0
            AND (`measuredParticipantLimit` IS NULL OR `measuredParticipantLimit` >= 0)
            AND (`measuredEncodedByteLimit` IS NULL OR `measuredEncodedByteLimit` >= 0)
        )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AccountEncryptionTransitionCollectionStage` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `transitionId` VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `collectionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `rowId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `sourceRevision` INTEGER NOT NULL,
    `sourceEnvelope` JSON NOT NULL,
    `targetEnvelope` JSON NULL,
    `schemaVersion` INTEGER NOT NULL,
    `contractDigest` VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceEncodedBytes` BIGINT NOT NULL,
    `targetEncodedBytes` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `AccountEncryptionTransitionCollectionStage_identity_key`(`transitionId`, `pluginId`, `collectionId`, `rowId`),
    INDEX `AccountEncryptionTransitionCollectionStage_transition_page_idx`(`transitionId`, `pluginId`, `collectionId`, `rowId`),
    CONSTRAINT `AccountEncryptionTransitionCollectionStage_transitionId_fkey`
        FOREIGN KEY (`transitionId`) REFERENCES `AccountEncryptionTransition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `AccountEncryptionTransitionCollectionStage_currentness_check`
        CHECK (`sourceRevision` >= 1 AND `schemaVersion` >= 1),
    CONSTRAINT `AccountEncryptionTransitionCollectionStage_byte_check`
        CHECK (
            `sourceEncodedBytes` >= 0
            AND (
                (`targetEnvelope` IS NULL AND `targetEncodedBytes` IS NULL)
                OR (`targetEnvelope` IS NOT NULL AND `targetEncodedBytes` >= 0)
            )
        ),
    CONSTRAINT `AccountEncryptionTransitionCollectionStage_contract_digest_check`
        CHECK (`contractDigest` REGEXP '^[A-Za-z0-9_-]{43}$')
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

UPDATE `PluginCollectionRow`
SET `contentEnvelope` = CAST('null' AS JSON)
WHERE `deletedAt` IS NOT NULL
  AND JSON_TYPE(`contentEnvelope`) <> 'NULL';
