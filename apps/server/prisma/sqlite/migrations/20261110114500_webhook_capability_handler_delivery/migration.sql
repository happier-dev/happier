-- align existing route and delivery verifier constraints with admitted webhook contracts.
-- The migration runner owns foreign-key directives outside its transaction.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_PluginWebhookRoute" (
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
        CHECK ("verifierKind" IN ('github_hmac_sha256_v1', 'sentry_hmac_sha256_v1', 'capabilityUrl_v1')),
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

INSERT INTO "new_PluginWebhookRoute" ("id", "opaqueRouteId", "verifierKind", "routingKind", "operatorPluginId", "operatorWebhookContributionId", "accountEndpointId", "enabled", "revokedAt", "policyVersion", "currentCredentialId", "previousCredentialId", "createdAt", "updatedAt")
SELECT "id", "opaqueRouteId", "verifierKind", "routingKind", "operatorPluginId", "operatorWebhookContributionId", "accountEndpointId", "enabled", "revokedAt", "policyVersion", "currentCredentialId", "previousCredentialId", "createdAt", "updatedAt" FROM "PluginWebhookRoute";

DROP TABLE "PluginWebhookRoute";
ALTER TABLE "new_PluginWebhookRoute" RENAME TO "PluginWebhookRoute";

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

CREATE TABLE "new_PluginWebhookDelivery" (
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
        CHECK ("verifierKind" IN ('github_hmac_sha256_v1', 'sentry_hmac_sha256_v1', 'capabilityUrl_v1')),
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

INSERT INTO "new_PluginWebhookDelivery" ("id", "endpointId", "accountId", "routeId", "deliveryIdentityDigest", "verifierKind", "targetMachineId", "targetMachineInstallationId", "targetMaterializationId", "targetPluginId", "targetPluginVersion", "endpointRevision", "endpointWebhookContributionId", "endpointHandlerActionId", "endpointSourceInstanceId", "payloadKind", "payload", "payloadBytes", "wireVersion", "payloadVersion", "state", "attemptCount", "replayCount", "nextAttemptAt", "offlineSinceAt", "leaseId", "claimedByMachineId", "claimedByMachineInstallationId", "firstClaimAt", "executionStartedAt", "leaseExpiresAt", "revision", "lastErrorCode", "automationAdmissionUnresolved", "terminalDisposition", "succeededAt", "deadLetteredAt", "discardedAt", "discardedByUserId", "discardReasonCode", "payloadPurgeAt", "metadataDeleteAt", "receivedAt", "createdAt", "updatedAt")
SELECT "id", "endpointId", "accountId", "routeId", "deliveryIdentityDigest", "verifierKind", "targetMachineId", "targetMachineInstallationId", "targetMaterializationId", "targetPluginId", "targetPluginVersion", "endpointRevision", "endpointWebhookContributionId", "endpointHandlerActionId", "endpointSourceInstanceId", "payloadKind", "payload", "payloadBytes", "wireVersion", "payloadVersion", "state", "attemptCount", "replayCount", "nextAttemptAt", "offlineSinceAt", "leaseId", "claimedByMachineId", "claimedByMachineInstallationId", "firstClaimAt", "executionStartedAt", "leaseExpiresAt", "revision", "lastErrorCode", "automationAdmissionUnresolved", "terminalDisposition", "succeededAt", "deadLetteredAt", "discardedAt", "discardedByUserId", "discardReasonCode", "payloadPurgeAt", "metadataDeleteAt", "receivedAt", "createdAt", "updatedAt" FROM "PluginWebhookDelivery";

DROP TABLE "PluginWebhookDelivery";
ALTER TABLE "new_PluginWebhookDelivery" RENAME TO "PluginWebhookDelivery";

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

CREATE TABLE "new_PluginWebhookEndpointOperation" (
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
        CHECK ("operationKind" IN ('revoke', 'retarget', 'rotateUrl')),
    CONSTRAINT "PluginWebhookEndpointOperation_result_kind_check"
        CHECK ("resultKind" IN ('revoked', 'alreadyRevoked', 'retargeted', 'alreadyRetargeted', 'rotated')),
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
            OR
            (
                "operationKind" = 'rotateUrl'
                AND "requestTargetMachineId" IS NULL
                AND "requestTargetMaterializationId" IS NULL
                AND "requestTargetPluginId" IS NULL
                AND "resultKind" = 'rotated'
                AND "resultPreviousTargetMachineId" IS NULL
                AND "resultPreviousTargetMaterializationId" IS NULL
                AND "resultPreviousTargetPluginId" IS NULL
                AND "resultTargetMachineId" IS NULL
                AND "resultTargetMaterializationId" IS NULL
                AND "resultTargetPluginId" IS NULL
            )
        ),
    CONSTRAINT "PluginWebhookEndpointOperation_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginWebhookEndpointOperation_endpointId_fkey"
        FOREIGN KEY ("endpointId") REFERENCES "PluginWebhookEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PluginWebhookEndpointOperation" ("id", "accountId", "endpointId", "operationKind", "idempotencyKey", "expectedRevision", "requestTargetMachineId", "requestTargetMaterializationId", "requestTargetPluginId", "resultKind", "resultRevision", "resultPreviousTargetMachineId", "resultPreviousTargetMaterializationId", "resultPreviousTargetPluginId", "resultTargetMachineId", "resultTargetMaterializationId", "resultTargetPluginId", "createdAt") SELECT "id", "accountId", "endpointId", "operationKind", "idempotencyKey", "expectedRevision", "requestTargetMachineId", "requestTargetMaterializationId", "requestTargetPluginId", "resultKind", "resultRevision", "resultPreviousTargetMachineId", "resultPreviousTargetMaterializationId", "resultPreviousTargetPluginId", "resultTargetMachineId", "resultTargetMaterializationId", "resultTargetPluginId", "createdAt" FROM "PluginWebhookEndpointOperation";
DROP TABLE "PluginWebhookEndpointOperation";
ALTER TABLE "new_PluginWebhookEndpointOperation" RENAME TO "PluginWebhookEndpointOperation";
CREATE UNIQUE INDEX "PluginWebhookEndpointOperation_endpointId_idempotencyKey_key"
ON "PluginWebhookEndpointOperation"("endpointId", "idempotencyKey");
CREATE INDEX "PluginWebhookEndpointOperation_accountId_idx"
ON "PluginWebhookEndpointOperation"("accountId");

PRAGMA foreign_keys=ON;
