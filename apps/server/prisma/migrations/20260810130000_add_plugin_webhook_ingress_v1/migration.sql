CREATE TABLE "PluginWebhookRoute" (
    "id" TEXT NOT NULL,
    "opaqueRouteId" VARCHAR(128) COLLATE "C" NOT NULL,
    "verifierKind" VARCHAR(64) COLLATE "C" NOT NULL,
    "routingKind" VARCHAR(64) COLLATE "C" NOT NULL,
    "operatorPluginId" VARCHAR(256) COLLATE "C",
    "operatorWebhookContributionId" VARCHAR(128) COLLATE "C",
    "accountEndpointId" VARCHAR(28) COLLATE "C",
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "currentCredentialId" TEXT,
    "previousCredentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginWebhookRoute_pkey" PRIMARY KEY ("id"),
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
        )
);

CREATE TABLE "PluginWebhookEndpoint" (
    "id" VARCHAR(28) COLLATE "C" NOT NULL,
    "accountId" TEXT,
    "pluginId" VARCHAR(256) COLLATE "C",
    "webhookContributionId" VARCHAR(128) COLLATE "C",
    "handlerActionId" VARCHAR(128) COLLATE "C",
    "sourceInstanceId" VARCHAR(128) COLLATE "C",
    "ensureIdempotencyKey" VARCHAR(128) COLLATE "C",
    "ensureRequestFingerprint" CHAR(64) COLLATE "C",
    "setupKind" VARCHAR(64) COLLATE "C",
    "routeId" TEXT NOT NULL,
    "routingKind" VARCHAR(64) COLLATE "C" NOT NULL,
    "providerInstallationId" VARCHAR(20) COLLATE "C",
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "tombstoneExpiresAt" TIMESTAMP(3),
    "targetMachineId" VARCHAR(256) COLLATE "C",
    "targetMachineInstallationId" VARCHAR(256) COLLATE "C",
    "targetMaterializationId" VARCHAR(256) COLLATE "C",
    "targetPluginVersion" VARCHAR(256) COLLATE "C",
    "previousTargetMachineId" VARCHAR(256) COLLATE "C",
    "previousTargetMachineInstallationId" VARCHAR(256) COLLATE "C",
    "previousTargetMaterializationId" VARCHAR(256) COLLATE "C",
    "previousTargetPluginVersion" VARCHAR(256) COLLATE "C",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginWebhookEndpoint_pkey" PRIMARY KEY ("id"),
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
                AND "enabled" = false
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
        )
);

CREATE TABLE "PluginWebhookEndpointOperation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "endpointId" VARCHAR(28) COLLATE "C" NOT NULL,
    "operationKind" VARCHAR(16) COLLATE "C" NOT NULL,
    "idempotencyKey" VARCHAR(128) COLLATE "C" NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "requestTargetMachineId" VARCHAR(256) COLLATE "C",
    "requestTargetMaterializationId" VARCHAR(256) COLLATE "C",
    "requestTargetPluginId" VARCHAR(256) COLLATE "C",
    "resultKind" VARCHAR(32) COLLATE "C" NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "resultPreviousTargetMachineId" VARCHAR(256) COLLATE "C",
    "resultPreviousTargetMaterializationId" VARCHAR(256) COLLATE "C",
    "resultPreviousTargetPluginId" VARCHAR(256) COLLATE "C",
    "resultTargetMachineId" VARCHAR(256) COLLATE "C",
    "resultTargetMaterializationId" VARCHAR(256) COLLATE "C",
    "resultTargetPluginId" VARCHAR(256) COLLATE "C",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginWebhookEndpointOperation_pkey" PRIMARY KEY ("id"),
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
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginWebhookEndpointOperation_endpointId_fkey"
        FOREIGN KEY ("endpointId") REFERENCES "PluginWebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PluginWebhookCredential" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "credentialVersionId" VARCHAR(64) COLLATE "C" NOT NULL,
    "verifierKind" VARCHAR(64) COLLATE "C" NOT NULL,
    "encryptedSecret" BYTEA NOT NULL,
    "state" VARCHAR(64) COLLATE "C" NOT NULL,
    "acceptUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginWebhookCredential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PluginWebhookCredential_state_check"
        CHECK ("state" IN ('current', 'previous'))
);

CREATE TABLE "PluginWebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" VARCHAR(28) COLLATE "C" NOT NULL,
    "accountId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "deliveryIdentityDigest" CHAR(64) COLLATE "C" NOT NULL,
    "verifierKind" VARCHAR(64) COLLATE "C" NOT NULL,
    "targetMachineId" VARCHAR(256) COLLATE "C" NOT NULL,
    "targetMachineInstallationId" VARCHAR(256) COLLATE "C" NOT NULL,
    "targetMaterializationId" VARCHAR(256) COLLATE "C" NOT NULL,
    "targetPluginId" VARCHAR(256) COLLATE "C" NOT NULL,
    "targetPluginVersion" VARCHAR(256) COLLATE "C" NOT NULL,
    "endpointRevision" INTEGER NOT NULL,
    "endpointWebhookContributionId" VARCHAR(256) COLLATE "C" NOT NULL,
    "endpointHandlerActionId" VARCHAR(256) COLLATE "C" NOT NULL,
    "endpointSourceInstanceId" VARCHAR(256) COLLATE "C" NOT NULL,
    "payloadKind" VARCHAR(16) COLLATE "C" NOT NULL,
    "payload" JSONB,
    "payloadBytes" BIGINT NOT NULL DEFAULT 0,
    "wireVersion" INTEGER NOT NULL,
    "payloadVersion" INTEGER NOT NULL,
    "state" VARCHAR(32) COLLATE "C" NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "offlineSinceAt" TIMESTAMP(3),
    "leaseId" VARCHAR(256) COLLATE "C",
    "claimedByMachineId" VARCHAR(256) COLLATE "C",
    "claimedByMachineInstallationId" VARCHAR(256) COLLATE "C",
    "firstClaimAt" TIMESTAMP(3),
    "executionStartedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(128) COLLATE "C",
    "automationAdmissionUnresolved" JSONB,
    "terminalDisposition" VARCHAR(128) COLLATE "C",
    "succeededAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),
    "discardedByUserId" TEXT,
    "discardReasonCode" VARCHAR(128) COLLATE "C",
    "payloadPurgeAt" TIMESTAMP(3),
    "metadataDeleteAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginWebhookDelivery_pkey" PRIMARY KEY ("id"),
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
        )
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

ALTER TABLE "PluginWebhookEndpoint"
    ADD CONSTRAINT "PluginWebhookEndpoint_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PluginWebhookEndpoint"
    ADD CONSTRAINT "PluginWebhookEndpoint_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "PluginWebhookRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginWebhookCredential"
    ADD CONSTRAINT "PluginWebhookCredential_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "PluginWebhookRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginWebhookDelivery"
    ADD CONSTRAINT "PluginWebhookDelivery_endpointId_fkey"
    FOREIGN KEY ("endpointId") REFERENCES "PluginWebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginWebhookDelivery"
    ADD CONSTRAINT "PluginWebhookDelivery_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginWebhookDelivery"
    ADD CONSTRAINT "PluginWebhookDelivery_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "PluginWebhookRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginWebhookRoute"
    ADD CONSTRAINT "PluginWebhookRoute_accountEndpointId_fkey"
    FOREIGN KEY ("accountEndpointId") REFERENCES "PluginWebhookEndpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginWebhookRoute"
    ADD CONSTRAINT "PluginWebhookRoute_currentCredentialId_fkey"
    FOREIGN KEY ("currentCredentialId") REFERENCES "PluginWebhookCredential"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PluginWebhookRoute"
    ADD CONSTRAINT "PluginWebhookRoute_previousCredentialId_fkey"
    FOREIGN KEY ("previousCredentialId") REFERENCES "PluginWebhookCredential"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
