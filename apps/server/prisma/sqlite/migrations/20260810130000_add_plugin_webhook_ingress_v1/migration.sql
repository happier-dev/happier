CREATE TABLE "PluginWebhookRoute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opaqueRouteId" TEXT COLLATE BINARY NOT NULL,
    "verifierKind" TEXT COLLATE BINARY NOT NULL,
    "routingKind" TEXT COLLATE BINARY NOT NULL,
    "operatorPluginId" TEXT COLLATE BINARY,
    "operatorWebhookContributionId" TEXT COLLATE BINARY,
    "accountEndpointId" TEXT COLLATE BINARY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" DATETIME,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "currentCredentialId" TEXT,
    "previousCredentialId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginWebhookRoute_verifier_kind_check"
        CHECK ("verifierKind" IN ('github_hmac_sha256_v1')),
    CONSTRAINT "PluginWebhookRoute_routing_kind_check"
        CHECK ("routingKind" IN ('accountEndpoint', 'providerInstallation')),
    CONSTRAINT "PluginWebhookRoute_operator_route_check"
        CHECK (
            ("routingKind" = 'accountEndpoint'
                AND "operatorPluginId" IS NULL
                AND "operatorWebhookContributionId" IS NULL)
            OR
            ("routingKind" = 'providerInstallation'
                AND "operatorPluginId" IS NOT NULL
                AND "operatorWebhookContributionId" IS NOT NULL)
        ),
    CONSTRAINT "PluginWebhookRoute_policy_version_check" CHECK ("policyVersion" >= 0),
    CONSTRAINT "PluginWebhookRoute_distinct_credential_check"
        CHECK (
            "currentCredentialId" IS NULL
            OR "previousCredentialId" IS NULL
            OR "currentCredentialId" <> "previousCredentialId"
        ),
    CONSTRAINT "PluginWebhookRoute_accountEndpointId_fkey"
        FOREIGN KEY ("accountEndpointId") REFERENCES "PluginWebhookEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PluginWebhookRoute_currentCredentialId_fkey"
        FOREIGN KEY ("currentCredentialId") REFERENCES "PluginWebhookCredential" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PluginWebhookRoute_previousCredentialId_fkey"
        FOREIGN KEY ("previousCredentialId") REFERENCES "PluginWebhookCredential" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "PluginWebhookEndpoint" (
    "id" TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "pluginId" TEXT COLLATE BINARY,
    "webhookContributionId" TEXT COLLATE BINARY,
    "handlerActionId" TEXT COLLATE BINARY,
    "sourceInstanceId" TEXT COLLATE BINARY,
    "ensureIdempotencyKey" TEXT COLLATE BINARY,
    "ensureRequestFingerprint" TEXT COLLATE BINARY,
    "setupKind" TEXT COLLATE BINARY,
    "routeId" TEXT NOT NULL,
    "routingKind" TEXT COLLATE BINARY NOT NULL,
    "providerInstallationId" TEXT COLLATE BINARY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" DATETIME,
    "releasedAt" DATETIME,
    "tombstoneExpiresAt" DATETIME,
    "targetMachineId" TEXT COLLATE BINARY,
    "targetMachineInstallationId" TEXT COLLATE BINARY,
    "targetMaterializationId" TEXT COLLATE BINARY,
    "targetPluginVersion" TEXT COLLATE BINARY,
    "previousTargetMachineId" TEXT COLLATE BINARY,
    "previousTargetMachineInstallationId" TEXT COLLATE BINARY,
    "previousTargetMaterializationId" TEXT COLLATE BINARY,
    "previousTargetPluginVersion" TEXT COLLATE BINARY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginWebhookEndpoint_routing_kind_check"
        CHECK ("routingKind" IN ('accountEndpoint', 'providerInstallation')),
    CONSTRAINT "PluginWebhookEndpoint_provider_installation_check"
        CHECK (
            ("routingKind" = 'accountEndpoint' AND "providerInstallationId" IS NULL)
            OR
            ("routingKind" = 'providerInstallation' AND "providerInstallationId" IS NOT NULL)
        ),
    CONSTRAINT "PluginWebhookEndpoint_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "PluginWebhookEndpoint_detached_tombstone_check"
        CHECK (
            "accountId" IS NOT NULL
            OR (
                "routingKind" = 'providerInstallation'
                AND "providerInstallationId" IS NOT NULL
                AND "pluginId" IS NULL
                AND "webhookContributionId" IS NULL
                AND "handlerActionId" IS NULL
                AND "sourceInstanceId" IS NULL
                AND "ensureIdempotencyKey" IS NULL
                AND "ensureRequestFingerprint" IS NULL
                AND "setupKind" IS NULL
                AND "enabled" = 0
                AND "revokedAt" IS NULL
                AND "targetMachineId" IS NULL
                AND "targetMachineInstallationId" IS NULL
                AND "targetMaterializationId" IS NULL
                AND "targetPluginVersion" IS NULL
                AND "previousTargetMachineId" IS NULL
                AND "previousTargetMachineInstallationId" IS NULL
                AND "previousTargetMaterializationId" IS NULL
                AND "previousTargetPluginVersion" IS NULL
                AND "releasedAt" IS NOT NULL
                AND "tombstoneExpiresAt" IS NOT NULL
            )
        ),
    CONSTRAINT "PluginWebhookEndpoint_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "PluginWebhookEndpoint_routeId_fkey"
        FOREIGN KEY ("routeId") REFERENCES "PluginWebhookRoute" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PluginWebhookEndpointOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "endpointId" TEXT COLLATE BINARY NOT NULL,
    "operationKind" TEXT COLLATE BINARY NOT NULL,
    "idempotencyKey" TEXT COLLATE BINARY NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "requestTargetMachineId" TEXT COLLATE BINARY,
    "requestTargetMaterializationId" TEXT COLLATE BINARY,
    "requestTargetPluginId" TEXT COLLATE BINARY,
    "resultKind" TEXT COLLATE BINARY NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "resultPreviousTargetMachineId" TEXT COLLATE BINARY,
    "resultPreviousTargetMaterializationId" TEXT COLLATE BINARY,
    "resultPreviousTargetPluginId" TEXT COLLATE BINARY,
    "resultTargetMachineId" TEXT COLLATE BINARY,
    "resultTargetMaterializationId" TEXT COLLATE BINARY,
    "resultTargetPluginId" TEXT COLLATE BINARY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PluginWebhookEndpointOperation_operation_kind_check"
        CHECK ("operationKind" IN ('revoke', 'retarget')),
    CONSTRAINT "PluginWebhookEndpointOperation_result_kind_check"
        CHECK ("resultKind" IN ('revoked', 'alreadyRevoked', 'retargeted', 'alreadyRetargeted')),
    CONSTRAINT "PluginWebhookEndpointOperation_revision_check"
        CHECK ("expectedRevision" >= 1 AND "resultRevision" >= 1),
    CONSTRAINT "PluginWebhookEndpointOperation_result_correspondence_check"
        CHECK (
            (
                "operationKind" = 'revoke'
                AND "requestTargetMachineId" IS NULL
                AND "requestTargetMaterializationId" IS NULL
                AND "requestTargetPluginId" IS NULL
                AND "resultKind" IN ('revoked', 'alreadyRevoked')
                AND "resultPreviousTargetMachineId" IS NULL
                AND "resultPreviousTargetMaterializationId" IS NULL
                AND "resultPreviousTargetPluginId" IS NULL
                AND "resultTargetMachineId" IS NULL
                AND "resultTargetMaterializationId" IS NULL
                AND "resultTargetPluginId" IS NULL
            )
            OR
            (
                "operationKind" = 'retarget'
                AND "requestTargetMachineId" IS NOT NULL
                AND "requestTargetMaterializationId" IS NOT NULL
                AND "requestTargetPluginId" IS NOT NULL
                AND "resultKind" IN ('retargeted', 'alreadyRetargeted')
                AND "resultPreviousTargetMachineId" IS NOT NULL
                AND "resultPreviousTargetMaterializationId" IS NOT NULL
                AND "resultPreviousTargetPluginId" IS NOT NULL
                AND "resultTargetMachineId" IS NOT NULL
                AND "resultTargetMaterializationId" IS NOT NULL
                AND "resultTargetPluginId" IS NOT NULL
            )
        ),
    CONSTRAINT "PluginWebhookEndpointOperation_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginWebhookEndpointOperation_endpointId_fkey"
        FOREIGN KEY ("endpointId") REFERENCES "PluginWebhookEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PluginWebhookCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "routeId" TEXT NOT NULL,
    "credentialVersionId" TEXT COLLATE BINARY NOT NULL,
    "verifierKind" TEXT COLLATE BINARY NOT NULL,
    "encryptedSecret" BLOB NOT NULL,
    "state" TEXT COLLATE BINARY NOT NULL,
    "acceptUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginWebhookCredential_state_check"
        CHECK ("state" IN ('current', 'previous')),
    CONSTRAINT "PluginWebhookCredential_routeId_fkey"
        FOREIGN KEY ("routeId") REFERENCES "PluginWebhookRoute" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PluginWebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT COLLATE BINARY NOT NULL,
    "accountId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "deliveryIdentityDigest" TEXT COLLATE BINARY NOT NULL,
    "verifierKind" TEXT COLLATE BINARY NOT NULL,
    "targetMachineId" TEXT COLLATE BINARY NOT NULL,
    "targetMachineInstallationId" TEXT COLLATE BINARY NOT NULL,
    "targetMaterializationId" TEXT COLLATE BINARY NOT NULL,
    "targetPluginId" TEXT COLLATE BINARY NOT NULL,
    "targetPluginVersion" TEXT COLLATE BINARY NOT NULL,
    "endpointRevision" INTEGER NOT NULL,
    "endpointWebhookContributionId" TEXT COLLATE BINARY NOT NULL,
    "endpointHandlerActionId" TEXT COLLATE BINARY NOT NULL,
    "endpointSourceInstanceId" TEXT COLLATE BINARY NOT NULL,
    "payloadKind" TEXT COLLATE BINARY NOT NULL,
    "payload" JSONB,
    "payloadBytes" INTEGER NOT NULL DEFAULT 0,
    "wireVersion" INTEGER NOT NULL,
    "payloadVersion" INTEGER NOT NULL,
    "state" TEXT COLLATE BINARY NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL,
    "offlineSinceAt" DATETIME,
    "leaseId" TEXT COLLATE BINARY,
    "claimedByMachineId" TEXT COLLATE BINARY,
    "claimedByMachineInstallationId" TEXT COLLATE BINARY,
    "firstClaimAt" DATETIME,
    "executionStartedAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT COLLATE BINARY,
    "automationAdmissionUnresolved" JSONB,
    "terminalDisposition" TEXT COLLATE BINARY,
    "succeededAt" DATETIME,
    "deadLetteredAt" DATETIME,
    "discardedAt" DATETIME,
    "discardedByUserId" TEXT,
    "discardReasonCode" TEXT COLLATE BINARY,
    "payloadPurgeAt" DATETIME,
    "metadataDeleteAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PluginWebhookDelivery_verifier_kind_check"
        CHECK ("verifierKind" IN ('github_hmac_sha256_v1')),
    CONSTRAINT "PluginWebhookDelivery_payload_kind_check"
        CHECK ("payloadKind" IN ('plain', 'encrypted')),
    CONSTRAINT "PluginWebhookDelivery_state_check"
        CHECK ("state" IN ('queued', 'claimed', 'succeeded', 'dead_letter', 'discarded')),
    CONSTRAINT "PluginWebhookDelivery_payload_bytes_check" CHECK ("payloadBytes" >= 0),
    CONSTRAINT "PluginWebhookDelivery_attempt_count_check" CHECK ("attemptCount" BETWEEN 0 AND 12),
    CONSTRAINT "PluginWebhookDelivery_replay_count_check" CHECK ("replayCount" BETWEEN 0 AND 10),
    CONSTRAINT "PluginWebhookDelivery_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "PluginWebhookDelivery_payload_state_check"
        CHECK (
            ("state" IN ('queued', 'claimed')
                AND "payload" IS NOT NULL
                AND "payloadBytes" > 0)
            OR
            ("state" IN ('succeeded', 'discarded')
                AND "payload" IS NULL
                AND "payloadBytes" = 0)
            OR
            ("state" = 'dead_letter'
                AND (
                    ("payload" IS NOT NULL AND "payloadBytes" > 0)
                    OR ("payload" IS NULL AND "payloadBytes" = 0)
                ))
        ),
    CONSTRAINT "PluginWebhookDelivery_endpointId_fkey"
        FOREIGN KEY ("endpointId") REFERENCES "PluginWebhookEndpoint" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PluginWebhookDelivery_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginWebhookDelivery_routeId_fkey"
        FOREIGN KEY ("routeId") REFERENCES "PluginWebhookRoute" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PluginWebhookRoute_opaqueRouteId_key"
ON "PluginWebhookRoute"("opaqueRouteId");
CREATE UNIQUE INDEX "plugin_webhook_route_operator_contribution_key"
ON "PluginWebhookRoute"("operatorPluginId", "operatorWebhookContributionId");
CREATE UNIQUE INDEX "PluginWebhookRoute_accountEndpointId_key"
ON "PluginWebhookRoute"("accountEndpointId");
CREATE UNIQUE INDEX "PluginWebhookRoute_currentCredentialId_key"
ON "PluginWebhookRoute"("currentCredentialId");
CREATE UNIQUE INDEX "PluginWebhookRoute_previousCredentialId_key"
ON "PluginWebhookRoute"("previousCredentialId");

CREATE UNIQUE INDEX "PluginWebhookEndpoint_accountId_ensureIdempotencyKey_key"
ON "PluginWebhookEndpoint"("accountId", "ensureIdempotencyKey");
CREATE UNIQUE INDEX "plugin_webhook_endpoint_account_contribution_source_key"
ON "PluginWebhookEndpoint"("accountId", "pluginId", "webhookContributionId", "sourceInstanceId");
CREATE UNIQUE INDEX "PluginWebhookEndpoint_routeId_providerInstallationId_key"
ON "PluginWebhookEndpoint"("routeId", "providerInstallationId");
CREATE INDEX "PluginWebhookEndpoint_tombstoneExpiresAt_idx"
ON "PluginWebhookEndpoint"("tombstoneExpiresAt");

CREATE UNIQUE INDEX "PluginWebhookEndpointOperation_endpointId_idempotencyKey_key"
ON "PluginWebhookEndpointOperation"("endpointId", "idempotencyKey");
CREATE INDEX "PluginWebhookEndpointOperation_accountId_idx"
ON "PluginWebhookEndpointOperation"("accountId");

CREATE UNIQUE INDEX "PluginWebhookCredential_credentialVersionId_key"
ON "PluginWebhookCredential"("credentialVersionId");

CREATE UNIQUE INDEX "PluginWebhookDelivery_deliveryIdentityDigest_key"
ON "PluginWebhookDelivery"("deliveryIdentityDigest");
CREATE INDEX "plugin_webhook_delivery_target_claim_idx"
ON "PluginWebhookDelivery"("targetMachineId", "targetMachineInstallationId", "targetMaterializationId", "state", "nextAttemptAt");
CREATE INDEX "PluginWebhookDelivery_state_leaseExpiresAt_idx"
ON "PluginWebhookDelivery"("state", "leaseExpiresAt");
CREATE INDEX "PluginWebhookDelivery_endpointId_state_idx"
ON "PluginWebhookDelivery"("endpointId", "state");
CREATE INDEX "PluginWebhookDelivery_accountId_state_idx"
ON "PluginWebhookDelivery"("accountId", "state");
CREATE INDEX "PluginWebhookDelivery_accountId_state_payloadBytes_idx"
ON "PluginWebhookDelivery"("accountId", "state", "payloadBytes");
CREATE INDEX "PluginWebhookDelivery_endpointId_state_payloadBytes_idx"
ON "PluginWebhookDelivery"("endpointId", "state", "payloadBytes");
CREATE INDEX "PluginWebhookDelivery_payloadPurgeAt_idx"
ON "PluginWebhookDelivery"("payloadPurgeAt");
CREATE INDEX "PluginWebhookDelivery_metadataDeleteAt_idx"
ON "PluginWebhookDelivery"("metadataDeleteAt");
