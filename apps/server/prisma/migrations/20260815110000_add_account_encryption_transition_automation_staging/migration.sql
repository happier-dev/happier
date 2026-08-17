CREATE TABLE "AccountEncryptionTransitionAutomationStageState" (
    "transitionId" VARCHAR(36) NOT NULL,
    "sourceParticipantCount" INTEGER NOT NULL,
    "sourceRunCount" INTEGER NOT NULL,
    "sourceEncodedBytes" BIGINT NOT NULL,
    "stagedParticipantCount" INTEGER NOT NULL,
    "stagedRunCount" INTEGER NOT NULL,
    "stagedSourceBytes" BIGINT NOT NULL,
    "stagedTargetBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountEncryptionTransitionAutomationStageState_pkey"
        PRIMARY KEY ("transitionId"),
    CONSTRAINT "AccountEncryptionTransitionAutomationStageState_transitionId_fkey"
        FOREIGN KEY ("transitionId") REFERENCES "AccountEncryptionTransition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountEncryptionTransitionAutomationStageState_counts_check"
        CHECK (
            "sourceParticipantCount" >= 0
            AND "sourceRunCount" >= 0
            AND "sourceRunCount" <= "sourceParticipantCount"
            AND "sourceEncodedBytes" >= 0
            AND "stagedParticipantCount" >= 0
            AND "stagedRunCount" >= 0
            AND "stagedRunCount" <= "stagedParticipantCount"
            AND "stagedSourceBytes" >= 0
            AND "stagedTargetBytes" >= 0
        )
);

CREATE TABLE "AccountEncryptionTransitionAutomationStage" (
    "id" VARCHAR(36) NOT NULL,
    "transitionId" VARCHAR(36) NOT NULL,
    "participantKind" VARCHAR(16) NOT NULL,
    "participantId" TEXT COLLATE "C" NOT NULL,
    "automationId" TEXT COLLATE "C" NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "sourceContent" TEXT NOT NULL,
    "targetContent" TEXT,
    "sourceEncodedBytes" BIGINT NOT NULL,
    "targetEncodedBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountEncryptionTransitionAutomationStage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AccountEncryptionTransitionAutomationStage_transitionId_fkey"
        FOREIGN KEY ("transitionId") REFERENCES "AccountEncryptionTransition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountEncryptionTransitionAutomationStage_kind_check"
        CHECK ("participantKind" IN ('definition', 'run')),
    CONSTRAINT "AccountEncryptionTransitionAutomationStage_currentness_check"
        CHECK ("sourceRevision" >= 0),
    CONSTRAINT "AccountEncryptionTransitionAutomationStage_bytes_check"
        CHECK (
            "sourceEncodedBytes" >= 0
            AND (
                ("targetContent" IS NULL AND "targetEncodedBytes" IS NULL)
                OR ("targetContent" IS NOT NULL AND "targetEncodedBytes" >= 0)
            )
        )
);

CREATE UNIQUE INDEX "AccountEncryptionTransitionAutomationStage_identity_key"
ON "AccountEncryptionTransitionAutomationStage"("transitionId", "participantKind", "participantId");
CREATE INDEX "AccountEncryptionTransitionAutomationStage_transition_page_idx"
ON "AccountEncryptionTransitionAutomationStage"("transitionId", "participantKind", "participantId");
