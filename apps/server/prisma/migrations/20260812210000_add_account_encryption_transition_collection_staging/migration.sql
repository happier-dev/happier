CREATE TABLE "AccountEncryptionTransition" (
    "id" VARCHAR(36) NOT NULL,
    "accountId" TEXT NOT NULL,
    "fromEncryptionMode" VARCHAR(16) NOT NULL,
    "toEncryptionMode" VARCHAR(16) NOT NULL,
    "sourceAccountVersion" INTEGER NOT NULL,
    "sourceSettingsVersion" INTEGER NOT NULL,
    "sourceSigningKeyFingerprint" VARCHAR(49) COLLATE "C",
    "sourceContentKeyFingerprint" VARCHAR(49) COLLATE "C",
    "targetSigningKeyFingerprint" VARCHAR(49) COLLATE "C",
    "targetContentKeyFingerprint" VARCHAR(49) COLLATE "C",
    "targetAccountPublicKey" VARCHAR(64) COLLATE "C",
    "targetContentPublicKey" BYTEA,
    "targetContentPublicKeySig" BYTEA,
    "status" VARCHAR(16) NOT NULL,
    "activeAccountId" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "authorizedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "activatedAccountVersion" INTEGER,
    "activatedAccountUpdatedAt" TIMESTAMP(3),
    "activatedAccountCursor" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "censusParticipantCount" INTEGER NOT NULL DEFAULT 0,
    "censusSourceBytes" BIGINT NOT NULL DEFAULT 0,
    "censusTargetBytes" BIGINT NOT NULL DEFAULT 0,
    "stagedParticipantCount" INTEGER NOT NULL DEFAULT 0,
    "stagedSourceBytes" BIGINT NOT NULL DEFAULT 0,
    "stagedTargetBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedCapacityBytes" BIGINT NOT NULL DEFAULT 0,
    "measuredParticipantLimit" INTEGER,
    "measuredEncodedByteLimit" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountEncryptionTransition_pkey" PRIMARY KEY ("id"),
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

CREATE UNIQUE INDEX "AccountEncryptionTransition_activeAccountId_key"
ON "AccountEncryptionTransition"("activeAccountId");
CREATE INDEX "AccountEncryptionTransition_account_status_expiry_idx"
ON "AccountEncryptionTransition"("accountId", "status", "expiresAt");

CREATE TABLE "AccountEncryptionTransitionCollectionStage" (
    "id" TEXT NOT NULL,
    "transitionId" VARCHAR(36) NOT NULL,
    "pluginId" TEXT COLLATE "C" NOT NULL,
    "collectionId" TEXT COLLATE "C" NOT NULL,
    "rowId" TEXT COLLATE "C" NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "sourceEnvelope" JSONB NOT NULL,
    "targetEnvelope" JSONB,
    "schemaVersion" INTEGER NOT NULL,
    "contractDigest" VARCHAR(43) COLLATE "C" NOT NULL,
    "sourceEncodedBytes" BIGINT NOT NULL,
    "targetEncodedBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountEncryptionTransitionCollectionStage_pkey" PRIMARY KEY ("id"),
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
        ),
    CONSTRAINT "AccountEncryptionTransitionCollectionStage_contract_digest_check"
        CHECK (char_length("contractDigest") = 43 AND "contractDigest" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE UNIQUE INDEX "AccountEncryptionTransitionCollectionStage_identity_key"
ON "AccountEncryptionTransitionCollectionStage"("transitionId", "pluginId", "collectionId", "rowId");
CREATE INDEX "AccountEncryptionTransitionCollectionStage_transition_page_idx"
ON "AccountEncryptionTransitionCollectionStage"("transitionId", "pluginId", "collectionId", "rowId");

UPDATE "PluginCollectionRow"
SET "contentEnvelope" = 'null'::jsonb
WHERE "deletedAt" IS NOT NULL
  AND "contentEnvelope" IS DISTINCT FROM 'null'::jsonb;
