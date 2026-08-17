-- Bounded non-authoritative target stages for DATA-EU7 candidate preparation.
-- Canonical Collection rows remain the only live reader/writer surface until
-- the Availability intent transaction promotes a complete exact stage set.
CREATE TABLE "PluginCollectionCandidatePreparationStage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "candidateIdentity" VARCHAR(43) NOT NULL,
    "sourceRowDbId" TEXT NOT NULL,
    "sourceContractId" TEXT NOT NULL,
    "sourceSchemaVersion" INTEGER NOT NULL,
    "sourceContractDigest" VARCHAR(43) NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "targetContractId" TEXT NOT NULL,
    "targetSchemaVersion" INTEGER NOT NULL,
    "targetContractDigest" VARCHAR(43) NOT NULL,
    "candidateReleaseVersion" TEXT NOT NULL,
    "candidateArtifactDigest" TEXT NOT NULL,
    "targetContentEnvelope" JSONB NOT NULL,
    "targetProjection" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginCollectionCandidatePreparationStage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PCCPS_account_fk"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PCCPS_source_row_fk"
        FOREIGN KEY ("sourceRowDbId") REFERENCES "PluginCollectionRow"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PCCPS_source_contract_fk"
        FOREIGN KEY ("sourceContractId") REFERENCES "PluginCollectionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PCCPS_target_contract_fk"
        FOREIGN KEY ("targetContractId") REFERENCES "PluginCollectionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PCCPS_currentness_check"
        CHECK (
            "sourceSchemaVersion" >= 1
            AND "targetSchemaVersion" >= 1
            AND "sourceRevision" >= 0
        ),
    CONSTRAINT "PCCPS_candidate_identity_check"
        CHECK ("candidateIdentity" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "PCCPS_source_digest_check"
        CHECK ("sourceContractDigest" ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT "PCCPS_target_digest_check"
        CHECK ("targetContractDigest" ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE UNIQUE INDEX "PluginCollectionCandidatePreparationStage_identity_key"
ON "PluginCollectionCandidatePreparationStage"("accountId", "candidateIdentity", "sourceRowDbId", "targetContractId");
CREATE INDEX "PluginCollectionCandidatePreparationStage_candidate_idx"
ON "PluginCollectionCandidatePreparationStage"("accountId", "pluginId");
CREATE INDEX "PluginCollectionCandidatePreparationStage_source_idx"
ON "PluginCollectionCandidatePreparationStage"("accountId", "sourceRowDbId");
