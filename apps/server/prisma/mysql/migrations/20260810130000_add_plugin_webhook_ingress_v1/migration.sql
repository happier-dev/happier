CREATE TABLE `PluginWebhookRoute` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `opaqueRouteId` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `verifierKind` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `routingKind` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `operatorPluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `operatorWebhookContributionId` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `accountEndpointId` VARCHAR(28) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `revokedAt` DATETIME(3) NULL,
    `policyVersion` INTEGER NOT NULL DEFAULT 1,
    `currentCredentialId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `previousCredentialId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginWebhookRoute_opaqueRouteId_key`(`opaqueRouteId`),
    UNIQUE INDEX `plugin_webhook_route_operator_contribution_key`(`operatorPluginId`, `operatorWebhookContributionId`),
    UNIQUE INDEX `PluginWebhookRoute_accountEndpointId_key`(`accountEndpointId`),
    UNIQUE INDEX `PluginWebhookRoute_currentCredentialId_key`(`currentCredentialId`),
    UNIQUE INDEX `PluginWebhookRoute_previousCredentialId_key`(`previousCredentialId`),
    CONSTRAINT `PluginWebhookRoute_verifier_kind_check`
        CHECK (`verifierKind` IN ('github_hmac_sha256_v1')),
    CONSTRAINT `PluginWebhookRoute_routing_kind_check`
        CHECK (`routingKind` IN ('accountEndpoint', 'providerInstallation')),
    CONSTRAINT `PluginWebhookRoute_operator_route_check`
        CHECK (
            (`routingKind` = 'accountEndpoint'
                AND `operatorPluginId` IS NULL
                AND `operatorWebhookContributionId` IS NULL)
            OR
            (`routingKind` = 'providerInstallation'
                AND `operatorPluginId` IS NOT NULL
                AND `operatorWebhookContributionId` IS NOT NULL)
        ),
    CONSTRAINT `PluginWebhookRoute_policy_version_check` CHECK (`policyVersion` >= 0),
    CONSTRAINT `PluginWebhookRoute_distinct_credential_check`
        CHECK (
            `currentCredentialId` IS NULL
            OR `previousCredentialId` IS NULL
            OR `currentCredentialId` <> `previousCredentialId`
        )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginWebhookEndpoint` (
    `id` VARCHAR(28) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NULL,
    `pluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `webhookContributionId` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `handlerActionId` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `sourceInstanceId` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `ensureIdempotencyKey` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `ensureRequestFingerprint` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `setupKind` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `routeId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `routingKind` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `providerInstallationId` VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `revokedAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,
    `tombstoneExpiresAt` DATETIME(3) NULL,
    `targetMachineId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetMachineInstallationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetMaterializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `targetPluginVersion` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `previousTargetMachineId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `previousTargetMachineInstallationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `previousTargetMaterializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `previousTargetPluginVersion` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginWebhookEndpoint_accountId_ensureIdempotencyKey_key`(`accountId`, `ensureIdempotencyKey`),
    UNIQUE INDEX `plugin_webhook_endpoint_account_contribution_source_key`(`accountId`, `pluginId`, `webhookContributionId`, `sourceInstanceId`),
    UNIQUE INDEX `PluginWebhookEndpoint_routeId_providerInstallationId_key`(`routeId`, `providerInstallationId`),
    INDEX `PluginWebhookEndpoint_tombstoneExpiresAt_idx`(`tombstoneExpiresAt`),
    CONSTRAINT `PluginWebhookEndpoint_routing_kind_check`
        CHECK (`routingKind` IN ('accountEndpoint', 'providerInstallation')),
    CONSTRAINT `PluginWebhookEndpoint_provider_installation_check`
        CHECK (
            (`routingKind` = 'accountEndpoint' AND `providerInstallationId` IS NULL)
            OR
            (`routingKind` = 'providerInstallation' AND `providerInstallationId` IS NOT NULL)
        ),
    CONSTRAINT `PluginWebhookEndpoint_revision_check` CHECK (`revision` >= 1),
    CONSTRAINT `PluginWebhookEndpoint_detached_tombstone_check`
        CHECK (
            `accountId` IS NOT NULL
            OR (
                `routingKind` = 'providerInstallation'
                AND `providerInstallationId` IS NOT NULL
                AND `pluginId` IS NULL
                AND `webhookContributionId` IS NULL
                AND `handlerActionId` IS NULL
                AND `sourceInstanceId` IS NULL
                AND `ensureIdempotencyKey` IS NULL
                AND `ensureRequestFingerprint` IS NULL
                AND `setupKind` IS NULL
                AND `enabled` = 0
                AND `revokedAt` IS NULL
                AND `targetMachineId` IS NULL
                AND `targetMachineInstallationId` IS NULL
                AND `targetMaterializationId` IS NULL
                AND `targetPluginVersion` IS NULL
                AND `previousTargetMachineId` IS NULL
                AND `previousTargetMachineInstallationId` IS NULL
                AND `previousTargetMaterializationId` IS NULL
                AND `previousTargetPluginVersion` IS NULL
                AND `releasedAt` IS NOT NULL
                AND `tombstoneExpiresAt` IS NOT NULL
            )
        ),
    CONSTRAINT `PluginWebhookEndpoint_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT `PluginWebhookEndpoint_routeId_fkey`
        FOREIGN KEY (`routeId`) REFERENCES `PluginWebhookRoute`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginWebhookEndpointOperation` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `endpointId` VARCHAR(28) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `operationKind` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `idempotencyKey` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `expectedRevision` INTEGER NOT NULL,
    `requestTargetMachineId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `requestTargetMaterializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `requestTargetPluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `resultKind` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `resultRevision` INTEGER NOT NULL,
    `resultPreviousTargetMachineId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `resultPreviousTargetMaterializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `resultPreviousTargetPluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `resultTargetMachineId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `resultTargetMaterializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `resultTargetPluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginWebhookEndpointOperation_endpointId_idempotencyKey_key`(`endpointId`, `idempotencyKey`),
    INDEX `PluginWebhookEndpointOperation_accountId_idx`(`accountId`),
    CONSTRAINT `PluginWebhookEndpointOperation_operation_kind_check`
        CHECK (`operationKind` IN ('revoke', 'retarget')),
    CONSTRAINT `PluginWebhookEndpointOperation_result_kind_check`
        CHECK (`resultKind` IN ('revoked', 'alreadyRevoked', 'retargeted', 'alreadyRetargeted')),
    CONSTRAINT `PluginWebhookEndpointOperation_revision_check`
        CHECK (`expectedRevision` >= 1 AND `resultRevision` >= 1),
    CONSTRAINT `PluginWebhookEndpointOperation_result_correspondence_check`
        CHECK (
            (
                `operationKind` = 'revoke'
                AND `requestTargetMachineId` IS NULL
                AND `requestTargetMaterializationId` IS NULL
                AND `requestTargetPluginId` IS NULL
                AND `resultKind` IN ('revoked', 'alreadyRevoked')
                AND `resultPreviousTargetMachineId` IS NULL
                AND `resultPreviousTargetMaterializationId` IS NULL
                AND `resultPreviousTargetPluginId` IS NULL
                AND `resultTargetMachineId` IS NULL
                AND `resultTargetMaterializationId` IS NULL
                AND `resultTargetPluginId` IS NULL
            )
            OR
            (
                `operationKind` = 'retarget'
                AND `requestTargetMachineId` IS NOT NULL
                AND `requestTargetMaterializationId` IS NOT NULL
                AND `requestTargetPluginId` IS NOT NULL
                AND `resultKind` IN ('retargeted', 'alreadyRetargeted')
                AND `resultPreviousTargetMachineId` IS NOT NULL
                AND `resultPreviousTargetMaterializationId` IS NOT NULL
                AND `resultPreviousTargetPluginId` IS NOT NULL
                AND `resultTargetMachineId` IS NOT NULL
                AND `resultTargetMaterializationId` IS NOT NULL
                AND `resultTargetPluginId` IS NOT NULL
            )
        ),
    CONSTRAINT `PluginWebhookEndpointOperation_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginWebhookEndpointOperation_endpointId_fkey`
        FOREIGN KEY (`endpointId`) REFERENCES `PluginWebhookEndpoint`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginWebhookCredential` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `routeId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `credentialVersionId` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `verifierKind` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `encryptedSecret` BLOB NOT NULL,
    `state` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `acceptUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginWebhookCredential_credentialVersionId_key`(`credentialVersionId`),
    CONSTRAINT `PluginWebhookCredential_state_check`
        CHECK (`state` IN ('current', 'previous')),
    CONSTRAINT `PluginWebhookCredential_routeId_fkey`
        FOREIGN KEY (`routeId`) REFERENCES `PluginWebhookRoute`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PluginWebhookDelivery` (
    `id` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `endpointId` VARCHAR(28) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `routeId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `deliveryIdentityDigest` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `verifierKind` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `targetMachineId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `targetMachineInstallationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `targetMaterializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `targetPluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `targetPluginVersion` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `endpointRevision` INTEGER NOT NULL,
    `endpointWebhookContributionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `endpointHandlerActionId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `endpointSourceInstanceId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `payloadKind` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `payload` JSON NULL,
    `payloadBytes` BIGINT NOT NULL DEFAULT 0,
    `wireVersion` INTEGER NOT NULL,
    `payloadVersion` INTEGER NOT NULL,
    `state` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `replayCount` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL,
    `offlineSinceAt` DATETIME(3) NULL,
    `leaseId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `claimedByMachineId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `claimedByMachineInstallationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `firstClaimAt` DATETIME(3) NULL,
    `executionStartedAt` DATETIME(3) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `lastErrorCode` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `automationAdmissionUnresolved` JSON NULL,
    `terminalDisposition` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `succeededAt` DATETIME(3) NULL,
    `deadLetteredAt` DATETIME(3) NULL,
    `discardedAt` DATETIME(3) NULL,
    `discardedByUserId` VARCHAR(191) NULL,
    `discardReasonCode` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    `payloadPurgeAt` DATETIME(3) NULL,
    `metadataDeleteAt` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `PluginWebhookDelivery_deliveryIdentityDigest_key`(`deliveryIdentityDigest`),
    INDEX `plugin_webhook_delivery_target_claim_idx`(
        `targetMachineId`(64),
        `targetMachineInstallationId`(64),
        `targetMaterializationId`(64),
        `state`(32),
        `nextAttemptAt`
    ),
    INDEX `PluginWebhookDelivery_state_leaseExpiresAt_idx`(`state`, `leaseExpiresAt`),
    INDEX `PluginWebhookDelivery_endpointId_state_idx`(`endpointId`, `state`),
    INDEX `PluginWebhookDelivery_accountId_state_idx`(`accountId`, `state`),
    INDEX `PluginWebhookDelivery_accountId_state_payloadBytes_idx`(`accountId`, `state`, `payloadBytes`),
    INDEX `PluginWebhookDelivery_endpointId_state_payloadBytes_idx`(`endpointId`, `state`, `payloadBytes`),
    INDEX `PluginWebhookDelivery_payloadPurgeAt_idx`(`payloadPurgeAt`),
    INDEX `PluginWebhookDelivery_metadataDeleteAt_idx`(`metadataDeleteAt`),
    CONSTRAINT `PluginWebhookDelivery_verifier_kind_check`
        CHECK (`verifierKind` IN ('github_hmac_sha256_v1')),
    CONSTRAINT `PluginWebhookDelivery_payload_kind_check`
        CHECK (`payloadKind` IN ('plain', 'encrypted')),
    CONSTRAINT `PluginWebhookDelivery_state_check`
        CHECK (`state` IN ('queued', 'claimed', 'succeeded', 'dead_letter', 'discarded')),
    CONSTRAINT `PluginWebhookDelivery_payload_bytes_check` CHECK (`payloadBytes` >= 0),
    CONSTRAINT `PluginWebhookDelivery_attempt_count_check` CHECK (`attemptCount` BETWEEN 0 AND 12),
    CONSTRAINT `PluginWebhookDelivery_replay_count_check` CHECK (`replayCount` BETWEEN 0 AND 10),
    CONSTRAINT `PluginWebhookDelivery_revision_check` CHECK (`revision` >= 0),
    CONSTRAINT `PluginWebhookDelivery_payload_state_check`
        CHECK (
            (`state` IN ('queued', 'claimed')
                AND `payload` IS NOT NULL
                AND `payloadBytes` > 0)
            OR
            (`state` IN ('succeeded', 'discarded')
                AND `payload` IS NULL
                AND `payloadBytes` = 0)
            OR
            (`state` = 'dead_letter'
                AND (
                    (`payload` IS NOT NULL AND `payloadBytes` > 0)
                    OR (`payload` IS NULL AND `payloadBytes` = 0)
                ))
        ),
    CONSTRAINT `PluginWebhookDelivery_endpointId_fkey`
        FOREIGN KEY (`endpointId`) REFERENCES `PluginWebhookEndpoint`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `PluginWebhookDelivery_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginWebhookDelivery_routeId_fkey`
        FOREIGN KEY (`routeId`) REFERENCES `PluginWebhookRoute`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PluginWebhookRoute`
    ADD CONSTRAINT `PluginWebhookRoute_accountEndpointId_fkey`
    FOREIGN KEY (`accountEndpointId`) REFERENCES `PluginWebhookEndpoint`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `PluginWebhookRoute`
    ADD CONSTRAINT `PluginWebhookRoute_currentCredentialId_fkey`
    FOREIGN KEY (`currentCredentialId`) REFERENCES `PluginWebhookCredential`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `PluginWebhookRoute`
    ADD CONSTRAINT `PluginWebhookRoute_previousCredentialId_fkey`
    FOREIGN KEY (`previousCredentialId`) REFERENCES `PluginWebhookCredential`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
