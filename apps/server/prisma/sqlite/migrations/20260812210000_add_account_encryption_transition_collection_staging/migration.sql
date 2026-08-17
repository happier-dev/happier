CREATE TABLE "AccountEncryptionTransition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "fromEncryptionMode" TEXT NOT NULL,
    "toEncryptionMode" TEXT NOT NULL,
    "sourceAccountVersion" INTEGER NOT NULL,
    "sourceSettingsVersion" INTEGER NOT NULL,
    "sourceSigningKeyFingerprint" TEXT,
    "sourceContentKeyFingerprint" TEXT,
    "targetSigningKeyFingerprint" TEXT,
    "targetContentKeyFingerprint" TEXT,
    "targetAccountPublicKey" TEXT,
    "targetContentPublicKey" BLOB,
    "targetContentPublicKeySig" BLOB,
    "status" TEXT NOT NULL,
    "activeAccountId" TEXT UNIQUE,
    "preparedAt" DATETIME NOT NULL,
    "authorizedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "activatedAt" DATETIME,
    "activatedAccountVersion" INTEGER,
    "activatedAccountUpdatedAt" DATETIME,
    "activatedAccountCursor" INTEGER,
    "cancelledAt" DATETIME,
    "expiredAt" DATETIME,
    "censusParticipantCount" INTEGER NOT NULL DEFAULT 0,
    "censusSourceBytes" BIGINT NOT NULL DEFAULT 0,
    "censusTargetBytes" BIGINT NOT NULL DEFAULT 0,
    "stagedParticipantCount" INTEGER NOT NULL DEFAULT 0,
    "stagedSourceBytes" BIGINT NOT NULL DEFAULT 0,
    "stagedTargetBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedCapacityBytes" BIGINT NOT NULL DEFAULT 0,
    "measuredParticipantLimit" INTEGER,
    "measuredEncodedByteLimit" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "AccountEncryptionTransition_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountEncryptionTransition_status_check"
        CHECK ("status" IN ('preparing', 'authorized', 'activated', 'cancelled', 'expired')),
    CONSTRAINT "AccountEncryptionTransition_mode_check"
        CHECK ("fromEncryptionMode" IN ('plain', 'e2ee') AND "toEncryptionMode" IN ('plain', 'e2ee')),
    CONSTRAINT "AccountEncryptionTransition_active_account_check"
        CHECK (
            ("status" IN ('preparing', 'authorized') AND "activeAccountId" = "accountId")
            OR ("status" IN ('activated', 'cancelled', 'expired') AND "activeAccountId" IS NULL)
        ),
    CONSTRAINT "AccountEncryptionTransition_currentness_check"
        CHECK ("sourceAccountVersion" >= 0 AND "sourceSettingsVersion" >= 0),
    CONSTRAINT "AccountEncryptionTransition_activation_result_check"
        CHECK (
            ("status" = 'activated'
                AND "activatedAt" IS NOT NULL
                AND "activatedAccountVersion" IS NOT NULL
                AND "activatedAccountUpdatedAt" IS NOT NULL
                AND "activatedAccountCursor" IS NOT NULL
                AND "activatedAccountVersion" >= 0
                AND "activatedAccountCursor" >= 0)
            OR
            ("status" <> 'activated'
                AND "activatedAccountVersion" IS NULL
                AND "activatedAccountUpdatedAt" IS NULL
                AND "activatedAccountCursor" IS NULL)
        ),
    CONSTRAINT "AccountEncryptionTransition_capacity_check"
        CHECK (
            "censusParticipantCount" >= 0
            AND "censusSourceBytes" >= 0
            AND "censusTargetBytes" >= 0
            AND "stagedParticipantCount" >= 0
            AND "stagedSourceBytes" >= 0
            AND "stagedTargetBytes" >= 0
            AND "reservedCapacityBytes" >= 0
            AND ("measuredParticipantLimit" IS NULL OR "measuredParticipantLimit" >= 0)
            AND ("measuredEncodedByteLimit" IS NULL OR "measuredEncodedByteLimit" >= 0)
        )
);

CREATE INDEX "AccountEncryptionTransition_account_status_expiry_idx"
ON "AccountEncryptionTransition"("accountId", "status", "expiresAt");

CREATE TABLE "AccountEncryptionTransitionCollectionStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transitionId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "sourceEnvelope" JSONB NOT NULL,
    "targetEnvelope" JSONB,
    "schemaVersion" INTEGER NOT NULL,
    "contractDigest" TEXT NOT NULL CHECK (length("contractDigest") = 43 AND "contractDigest" NOT GLOB '*[^A-Za-z0-9_-]*'),
    "sourceEncodedBytes" BIGINT NOT NULL,
    "targetEncodedBytes" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "AccountEncryptionTransitionCollectionStage_transitionId_fkey"
        FOREIGN KEY ("transitionId") REFERENCES "AccountEncryptionTransition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountEncryptionTransitionCollectionStage_currentness_check"
        CHECK ("sourceRevision" >= 1 AND "schemaVersion" >= 1),
    CONSTRAINT "AccountEncryptionTransitionCollectionStage_byte_check"
        CHECK (
            "sourceEncodedBytes" >= 0
            AND (
                ("targetEnvelope" IS NULL AND "targetEncodedBytes" IS NULL)
                OR ("targetEnvelope" IS NOT NULL AND "targetEncodedBytes" >= 0)
            )
        )
);

CREATE UNIQUE INDEX "AccountEncryptionTransitionCollectionStage_identity_key"
ON "AccountEncryptionTransitionCollectionStage"("transitionId", "pluginId", "collectionId", "rowId");
CREATE INDEX "AccountEncryptionTransitionCollectionStage_transition_page_idx"
ON "AccountEncryptionTransitionCollectionStage"("transitionId", "pluginId", "collectionId", "rowId");

UPDATE "PluginCollectionRow"
SET "contentEnvelope" = json('null')
WHERE "deletedAt" IS NOT NULL
  AND json_type("contentEnvelope") <> 'null';
