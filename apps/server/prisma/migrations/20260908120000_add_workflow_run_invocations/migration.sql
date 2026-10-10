CREATE TYPE "WorkflowRunCustodyState" AS ENUM ('pending', 'settled');
CREATE TYPE "WorkflowInvocationLifecycle" AS ENUM ('pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval', 'waiting_for_review', 'needs_attention', 'completed', 'failed', 'skipped', 'cancel_requested', 'cancelled', 'outcome_uncertain', 'superseded');

ALTER TABLE "AccountEncryptionTransitionAutomationStage"
    ALTER COLUMN "participantKind" TYPE VARCHAR(32),
    ALTER COLUMN "automationId" DROP NOT NULL,
    ALTER COLUMN "sourceRevision" DROP NOT NULL;
ALTER TABLE "AccountEncryptionTransitionAutomationStage"
    DROP CONSTRAINT "AccountEncryptionTransitionAutomationStage_kind_check",
    DROP CONSTRAINT "AccountEncryptionTransitionAutomationStage_currentness_check";
ALTER TABLE "AccountEncryptionTransitionAutomationStage"
    ADD CONSTRAINT "AccountEncryptionTransitionAutomationStage_kind_check"
        CHECK ("participantKind" IN ('definition', 'run', 'workflow_invocation')),
    ADD CONSTRAINT "AccountEncryptionTransitionAutomationStage_currentness_check"
        CHECK (
            ("participantKind" = 'definition' AND "automationId" IS NOT NULL AND "sourceRevision" >= 0)
            OR ("participantKind" = 'run' AND "sourceRevision" >= 0)
            OR ("participantKind" = 'workflow_invocation' AND "automationId" IS NULL AND "sourceRevision" IS NULL)
        );

ALTER TABLE "Automation" ALTER COLUMN "targetType" DROP NOT NULL;

ALTER TYPE "AutomationRunState" ADD VALUE IF NOT EXISTS 'pause_requested';
ALTER TYPE "AutomationRunState" ADD VALUE IF NOT EXISTS 'paused';
ALTER TYPE "AutomationRunState" ADD VALUE IF NOT EXISTS 'interrupted';
ALTER TYPE "AutomationRunState" ADD VALUE IF NOT EXISTS 'waiting_for_review';

ALTER TABLE "AutomationRun"
    ALTER COLUMN "automationId" DROP NOT NULL,
    ALTER COLUMN "causeKind" DROP NOT NULL,
    ADD COLUMN "originKind" TEXT NOT NULL DEFAULT 'automation',
    ADD COLUMN "originSessionId" TEXT,
    ADD COLUMN "workflowAcceptedSnapshotEnvelope" TEXT,
    ADD COLUMN "workflowCheckpointEnvelope" TEXT,
    ADD COLUMN "workflowCustodyState" "WorkflowRunCustodyState",
    ADD COLUMN "workflowResumeRequestedRevision" INTEGER,
    ADD COLUMN "originDeliveryAckRevision" INTEGER,
    ADD COLUMN "visibleTeamId" TEXT;

ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_originSessionId_fkey"
    FOREIGN KEY ("originSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WorkflowRunInvocation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "parentRecordId" TEXT,
    "memberOrdinal" BIGINT NOT NULL,
    "attempt" BIGINT NOT NULL DEFAULT 0,
    "contentRevision" BIGINT NOT NULL DEFAULT 0,
    "lifecycle" "WorkflowInvocationLifecycle" NOT NULL DEFAULT 'pending',
    "contentEnvelope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkflowRunInvocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkflowRunInvocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRunInvocation_counter_check" CHECK ("sequence" >= 0 AND "memberOrdinal" >= 0 AND "attempt" >= 0 AND "contentRevision" >= 0)
);

CREATE TABLE "WorkflowRunDataKeyEnvelope" (
    "runId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "encryptedDataKey" BYTEA NOT NULL,
    "recipientContentPublicKeyFingerprint" TEXT NOT NULL,
    CONSTRAINT "WorkflowRunDataKeyEnvelope_pkey" PRIMARY KEY ("runId", "recipientAccountId"),
    CONSTRAINT "WorkflowRunDataKeyEnvelope_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRunDataKeyEnvelope_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorkflowRunDataKeyEnvelope_recipientAccountId_idx" ON "WorkflowRunDataKeyEnvelope"("recipientAccountId");

CREATE UNIQUE INDEX "WorkflowRunInvocation_run_sequence_key" ON "WorkflowRunInvocation"("runId", "sequence");
CREATE UNIQUE INDEX "WorkflowRunInvocation_slot_attempt_key" ON "WorkflowRunInvocation"("runId", "parentRecordId", "memberOrdinal", "attempt");
CREATE INDEX "WorkflowRunInvocation_lifecycle_idx" ON "WorkflowRunInvocation"("runId", "lifecycle", "sequence");
CREATE INDEX "AutomationRun_account_origin_created_id_idx" ON "AutomationRun"("accountId", "originKind", "createdAt" DESC, "id" DESC);
CREATE INDEX "AutomationRun_account_created_id_idx" ON "AutomationRun"("accountId", "createdAt" DESC, "id" DESC);
CREATE INDEX "AutomationRun_originSession_created_id_idx" ON "AutomationRun"("originSessionId", "createdAt" DESC, "id" DESC);

ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_origin_kind_check" CHECK (
    ("originKind" = 'automation' AND "automationId" IS NOT NULL AND "causeKind" IS NOT NULL)
    OR ("originKind" = 'direct'
        AND "automationId" IS NULL
        AND "triggerId" IS NULL
        AND "causeKind" IS NULL
        AND "causeTriggerKind" IS NULL
        AND "causeTriggerRevision" IS NULL
        AND "causeEventPluginId" IS NULL
        AND "causeEventLocalId" IS NULL
        AND "causeOccurredAt" IS NULL
        AND "causeScheduledFor" IS NULL
        AND "causeSessionLifecycleEvent" IS NULL
        AND "causeSourceSessionId" IS NULL
        AND "causeSourceTurnId" IS NULL
        AND "causeSessionLifecycleRequestId" IS NULL
        AND "causeSessionLifecycleRequestKind" IS NULL
        AND "causeSessionLifecyclePolicyKind" IS NULL
        AND "causeSessionLifecycleConfiguredCount" IS NULL
        AND "occurrenceKey" IS NULL
        AND "idempotencyKey" IS NULL
        AND "occurrenceEvidenceEqualityTag" IS NULL
        AND "causeSourceSelectorId" IS NULL
        AND "triggerEvidenceEnvelope" IS NULL
        AND "replyContextEnvelope" IS NULL
        AND "replyHandoffActionPluginId" IS NULL
        AND "replyHandoffActionLocalId" IS NULL
        AND "replyHandoffTargetMachineId" IS NULL
        AND "replyHandoffTargetMachineInstallationId" IS NULL
        AND "replyHandoffTargetMaterializationId" IS NULL
        AND "replyHandoffId" IS NULL
        AND "replyHandoffDueAt" IS NULL
        AND "replyHandoffState" = 'none'
        AND "replyHandoffAttempt" = 0
        AND "workflowAcceptedSnapshotEnvelope" IS NOT NULL
        AND "workflowCustodyState" IS NOT NULL)
);

-- Retained Automation-only checks remain authoritative for Automation origins,
-- while a direct workflow has deliberately null Automation cause/reply arms.
DO $$
DECLARE
    constraint_name TEXT;
    prior_definition TEXT;
    inner_expression TEXT;
BEGIN
    FOREACH constraint_name IN ARRAY ARRAY['AutomationRun_cause_arm_check', 'AutomationRun_reply_handoff_arm_check'] LOOP
        SELECT pg_get_constraintdef(oid) INTO prior_definition
        FROM pg_constraint
        WHERE conrelid = '"AutomationRun"'::regclass AND conname = constraint_name;
        IF prior_definition IS NOT NULL THEN
            inner_expression := substring(prior_definition FROM 8 FOR char_length(prior_definition) - 8);
            EXECUTE format('ALTER TABLE "AutomationRun" DROP CONSTRAINT %I', constraint_name);
            EXECUTE format(
                'ALTER TABLE "AutomationRun" ADD CONSTRAINT %I CHECK (("originKind" = ''direct'') OR (%s))',
                constraint_name,
                inner_expression
            );
        END IF;
    END LOOP;
END $$;

ALTER TABLE "AutomationRun" DROP CONSTRAINT "AutomationRun_execution_input_arm_check";
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_execution_input_arm_check" CHECK (
    "state" NOT IN ('queued', 'claimed', 'running')
    OR "executionInputEnvelope" IS NOT NULL
    OR "workflowAcceptedSnapshotEnvelope" IS NOT NULL
    OR ("state" IN ('queued', 'claimed') AND "startedAt" IS NULL
        AND "finishedAt" IS NULL AND "producedSessionId" IS NULL
        AND "summaryCiphertext" IS NULL AND "resultEnvelope" IS NULL
        AND "executionAttempt" = 0 AND "executionDispatchCommittedAt" IS NULL
        AND ("executionDispatchState" IS NULL OR "executionDispatchState" = 'notStarted')
        AND "executionNativeRunId" IS NULL AND "executionNativeCallId" IS NULL
        AND "executionNativeSidechainId" IS NULL)
);
