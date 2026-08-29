-- The released V2 writer could create queued/claimed/running Runs without a
-- frozen execution recipe. Those opaque bytes cannot be reconstructed by a
-- migration. Activation therefore requires the released worker to drain or
-- cancel every open predecessor Run before this transition is applied.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "AutomationRun"
        WHERE "state" IN ('queued', 'claimed', 'running')
    ) THEN
        RAISE EXCEPTION
            'Automation activation requires zero open predecessor AutomationRun rows; keep the released worker active and drain or cancel them first';
    END IF;
END $$;

CREATE TYPE "AutomationTriggerKind" AS ENUM ('schedule', 'pluginEvent', 'sessionLifecycle');
CREATE TYPE "AutomationSessionLifecycleEvent" AS ENUM ('parentTurnCompleted');
CREATE TYPE "AutomationObservationTransport" AS ENUM ('checkpointedPull', 'durablePush', 'socket');
CREATE TYPE "AutomationRunCauseKind" AS ENUM ('trigger', 'manual', 'conversation');
CREATE TYPE "AutomationExecutionDispatchState" AS ENUM ('notStarted', 'dispatchPermitted', 'retryWaiting', 'started', 'settled', 'outcomeUnknown');
CREATE TYPE "AutomationRunReplyHandoffState" AS ENUM ('none', 'awaitingResult', 'ready', 'handingOff', 'accepted', 'suppressed', 'blocked');
CREATE TYPE "AutomationEventSourceStatusState" AS ENUM ('uninitialized', 'baselined', 'observing', 'backingOff', 'attention');
CREATE TYPE "AutomationEventSourceCatalogStatusState" AS ENUM ('current', 'reconciling', 'reconciliationLate');

ALTER TYPE "AutomationTargetType" ADD VALUE 'execution_run';
ALTER TYPE "AutomationRunState" ADD VALUE 'dispatch_failed';
ALTER TYPE "AutomationRunState" ADD VALUE 'skipped';
ALTER TYPE "AutomationRunState" ADD VALUE 'missed';
ALTER TYPE "AutomationRunState" ADD VALUE 'outcome_uncertain';

ALTER TABLE "Automation"
    ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "AutomationRun"
    ADD COLUMN "triggerId" TEXT,
    ADD COLUMN "causeKind" "AutomationRunCauseKind" NOT NULL DEFAULT 'trigger',
    ADD COLUMN "causeTriggerKind" "AutomationTriggerKind",
    ADD COLUMN "causeTriggerRevision" INTEGER,
    ADD COLUMN "causeEventPluginId" TEXT,
    ADD COLUMN "causeEventLocalId" TEXT,
    ADD COLUMN "causeOccurredAt" TIMESTAMP(3),
    ADD COLUMN "causeScheduledFor" TIMESTAMP(3),
    ADD COLUMN "causeSessionLifecycleEvent" "AutomationSessionLifecycleEvent",
    ADD COLUMN "causeSourceSessionId" TEXT,
    ADD COLUMN "causeSourceTurnId" TEXT,
    ADD COLUMN "occurrenceKey" TEXT,
    ADD COLUMN "occurrenceEvidenceEqualityTag" TEXT,
    ADD COLUMN "causeSourceSelectorId" TEXT,
    ADD COLUMN "triggerEvidenceEnvelope" TEXT,
    ADD COLUMN "executionInputEnvelope" TEXT,
    ADD COLUMN "executionDispatchState" "AutomationExecutionDispatchState",
    ADD COLUMN "executionAttempt" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "executionDispatchCommittedAt" TIMESTAMP(3),
    ADD COLUMN "executionDispatchDueAt" TIMESTAMP(3),
    ADD COLUMN "executionNativeRunId" TEXT,
    ADD COLUMN "executionNativeCallId" TEXT,
    ADD COLUMN "executionNativeSidechainId" TEXT,
    ADD COLUMN "resultEnvelope" TEXT,
    ADD COLUMN "replyContextEnvelope" TEXT,
    ADD COLUMN "replyHandoffActionPluginId" TEXT,
    ADD COLUMN "replyHandoffActionLocalId" TEXT,
    ADD COLUMN "replyHandoffTargetMachineId" TEXT,
    ADD COLUMN "replyHandoffTargetMachineInstallationId" TEXT,
    ADD COLUMN "replyHandoffTargetMaterializationId" TEXT,
    ADD COLUMN "replyHandoffId" TEXT,
    ADD COLUMN "replyHandoffState" "AutomationRunReplyHandoffState" NOT NULL DEFAULT 'none',
    ADD COLUMN "replyHandoffAttempt" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "replyHandoffDueAt" TIMESTAMP(3),
    ADD COLUMN "replyHandoffReceiptEnvelope" TEXT,
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AutomationTrigger" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "kind" "AutomationTriggerKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "scheduleKind" "AutomationScheduleKind",
    "scheduleExpr" TEXT,
    "everyMs" INTEGER,
    "timezone" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "eventPluginId" TEXT,
    "eventLocalId" TEXT,
    "sourceSelectorId" TEXT,
    "sourceContractVersion" INTEGER,
    "observationTransport" "AutomationObservationTransport",
    "webhookEndpointId" TEXT,
    "observationStartsAt" TIMESTAMP(3),
    "watcherMachineId" TEXT,
    "watcherMachineInstallationId" TEXT,
    "watcherPluginId" TEXT,
    "watcherMaterializationId" TEXT,
    "definitionEnvelope" TEXT,
    "sessionLifecycleEvent" "AutomationSessionLifecycleEvent",
    "sourceSessionId" TEXT,
    "sourceTurnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutomationTrigger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutomationTrigger_automationId_fkey"
        FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationTrigger_arm_check" CHECK (
        ("deletedAt" IS NOT NULL AND "enabled" = false AND "kind" <> 'pluginEvent' AND "nextRunAt" IS NULL
            AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL AND "everyMs" IS NULL AND "timezone" IS NULL
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL
            AND "definitionEnvelope" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "sessionLifecycleEvent" IS NULL AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL)
        OR ("deletedAt" IS NOT NULL AND "enabled" = false AND "kind" = 'pluginEvent'
            AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL AND "everyMs" IS NULL
            AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NOT NULL AND "eventLocalId" IS NOT NULL
            AND "sourceSelectorId" IS NOT NULL AND "sourceContractVersion" IS NOT NULL
            AND "definitionEnvelope" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "sessionLifecycleEvent" IS NULL AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL)
        OR ("deletedAt" IS NULL AND "kind" = 'schedule' AND "scheduleKind" IS NOT NULL
            AND (("scheduleKind" = 'cron' AND "scheduleExpr" IS NOT NULL AND "everyMs" IS NULL)
                OR ("scheduleKind" = 'interval' AND "scheduleExpr" IS NULL AND "everyMs" IS NOT NULL))
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "definitionEnvelope" IS NULL
            AND "sessionLifecycleEvent" IS NULL AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL)
        OR ("deletedAt" IS NULL AND "kind" = 'pluginEvent' AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL
            AND "everyMs" IS NULL AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NOT NULL AND "eventLocalId" IS NOT NULL
            AND "sourceSelectorId" IS NOT NULL AND "sourceContractVersion" IS NOT NULL
            AND "observationTransport" IS NOT NULL
            AND "definitionEnvelope" IS NOT NULL
            AND "sessionLifecycleEvent" IS NULL AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL
            AND (("observationTransport" = 'checkpointedPull' AND "webhookEndpointId" IS NULL
                    AND "observationStartsAt" IS NULL
                    AND (("watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
                            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL)
                        OR ("watcherMachineId" IS NOT NULL AND "watcherMachineInstallationId" IS NOT NULL
                            AND "watcherPluginId" IS NOT NULL AND "watcherMaterializationId" IS NOT NULL)))
                OR ("observationTransport" = 'socket' AND "webhookEndpointId" IS NULL
                    AND "observationStartsAt" IS NULL
                    AND "watcherMachineId" IS NOT NULL AND "watcherMachineInstallationId" IS NOT NULL
                    AND "watcherPluginId" IS NOT NULL AND "watcherMaterializationId" IS NOT NULL)
                OR ("observationTransport" = 'durablePush' AND "webhookEndpointId" IS NOT NULL
                    AND "observationStartsAt" IS NOT NULL AND "watcherMachineId" IS NULL
                    AND "watcherMachineInstallationId" IS NULL AND "watcherPluginId" IS NULL
                    AND "watcherMaterializationId" IS NULL)))
        OR ("deletedAt" IS NULL AND "kind" = 'sessionLifecycle' AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL
            AND "everyMs" IS NULL AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "definitionEnvelope" IS NULL
            AND "sessionLifecycleEvent" IS NOT NULL
            AND "sessionLifecycleEvent" = 'parentTurnCompleted'
            AND "sourceSessionId" IS NOT NULL AND "sourceTurnId" IS NOT NULL)
    )
);

INSERT INTO "AutomationTrigger" (
    "id", "automationId", "kind", "enabled", "scheduleKind", "scheduleExpr",
    "everyMs", "timezone", "nextRunAt", "createdAt", "updatedAt"
)
SELECT "id", "id", 'schedule', true, "scheduleKind", "scheduleExpr",
    "everyMs", "timezone", "nextRunAt", "createdAt", "updatedAt"
FROM "Automation";

UPDATE "AutomationRun" AS run
SET
    "triggerId" = CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt"
        THEN run."automationId" ELSE NULL END,
    "causeKind" = CASE WHEN run."idempotencyKey" IS NOT NULL OR run."dueAt" = run."scheduledAt"
        THEN 'manual'::"AutomationRunCauseKind" ELSE 'trigger'::"AutomationRunCauseKind" END,
    "causeTriggerKind" = CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt"
        THEN 'schedule'::"AutomationTriggerKind" ELSE NULL END,
    "causeTriggerRevision" = CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt" THEN 0 ELSE NULL END,
    "causeOccurredAt" = CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt"
        THEN run."dueAt" ELSE run."createdAt" END,
    "causeScheduledFor" = CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt"
        THEN run."dueAt" ELSE NULL END,
    "occurrenceKey" = CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt"
        THEN substring(run."id" || '_' || run."automationId" || '___________________________________________' FROM 1 FOR 43)
        ELSE NULL END,
    "resultEnvelope" = CASE WHEN run."summaryCiphertext" IS NOT NULL
        THEN json_build_object('t', 'legacySummaryCiphertext', 'c', run."summaryCiphertext")::text
        ELSE NULL END;

ALTER TABLE "Automation"
    DROP COLUMN "scheduleKind",
    DROP COLUMN "scheduleExpr",
    DROP COLUMN "everyMs",
    DROP COLUMN "timezone",
    DROP COLUMN "nextRunAt";

ALTER TABLE "AutomationRun"
    DROP CONSTRAINT "AutomationRun_automationId_fkey";
ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_automationId_fkey"
        FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_cause_arm_check" CHECK (
        ("causeKind" = 'trigger' AND "idempotencyKey" IS NULL AND "causeTriggerKind" IS NOT NULL
            AND "triggerId" IS NOT NULL AND "causeTriggerRevision" IS NOT NULL
            AND "causeOccurredAt" IS NOT NULL AND "occurrenceKey" IS NOT NULL AND (
                ("causeTriggerKind" = 'schedule' AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
                    AND "causeScheduledFor" IS NOT NULL
                    AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL
                    AND "causeSourceSelectorId" IS NULL AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL)
                OR ("causeTriggerKind" = 'pluginEvent' AND "causeEventPluginId" IS NOT NULL AND "causeEventLocalId" IS NOT NULL
                    AND "causeScheduledFor" IS NULL
                    AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL
                    AND "causeSourceSelectorId" IS NOT NULL AND "triggerEvidenceEnvelope" IS NOT NULL
                    AND ((COALESCE(("triggerEvidenceEnvelope"::jsonb ->> 't') = 'plain', FALSE)
                            AND "occurrenceEvidenceEqualityTag" IS NULL)
                        OR (COALESCE(("triggerEvidenceEnvelope"::jsonb ->> 't') = 'encrypted', FALSE)
                            AND "occurrenceEvidenceEqualityTag" IS NOT NULL
                            AND char_length("occurrenceEvidenceEqualityTag") = 43
                            AND "occurrenceEvidenceEqualityTag" ~ '^[A-Za-z0-9_-]{43}$')))
                OR ("causeTriggerKind" = 'sessionLifecycle' AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
                    AND "causeScheduledFor" IS NULL
                    AND "causeSessionLifecycleEvent" IS NOT NULL
                    AND "causeSessionLifecycleEvent" = 'parentTurnCompleted' AND "causeSourceSessionId" IS NOT NULL
                    AND "causeSourceTurnId" IS NOT NULL AND "causeSourceSelectorId" IS NULL
                    AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL)
            ))
        OR ("causeKind" = 'manual' AND "triggerId" IS NULL AND "causeTriggerKind" IS NULL
            AND "causeTriggerRevision" IS NULL AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
            AND "causeOccurredAt" IS NOT NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL
            AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL
            AND "occurrenceKey" IS NULL AND "causeSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL)
        OR ("causeKind" = 'conversation'
            AND "idempotencyKey" IS NULL
            AND "triggerId" IS NULL AND "causeTriggerKind" IS NULL
            AND "causeTriggerRevision" IS NULL AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
            AND "causeOccurredAt" IS NOT NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL
            AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL
            AND "occurrenceKey" IS NOT NULL AND "causeSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NOT NULL
            AND ((COALESCE(("triggerEvidenceEnvelope"::jsonb ->> 't') = 'plain', FALSE)
                    AND "occurrenceEvidenceEqualityTag" IS NULL)
                OR (COALESCE(("triggerEvidenceEnvelope"::jsonb ->> 't') = 'encrypted', FALSE)
                    AND "occurrenceEvidenceEqualityTag" IS NOT NULL
                    AND char_length("occurrenceEvidenceEqualityTag") = 43
                    AND "occurrenceEvidenceEqualityTag" ~ '^[A-Za-z0-9_-]{43}$')))
    );

ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_execution_input_arm_check" CHECK (
        "state" NOT IN ('queued', 'claimed', 'running')
        OR "executionInputEnvelope" IS NOT NULL
    );

ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_reply_handoff_arm_check" CHECK (
        ("causeKind" = 'conversation' AND "replyContextEnvelope" IS NOT NULL
            AND "replyHandoffActionPluginId" IS NOT NULL AND "replyHandoffActionLocalId" IS NOT NULL
            AND "replyHandoffTargetMachineId" IS NOT NULL AND "replyHandoffTargetMachineInstallationId" IS NOT NULL
            AND "replyHandoffTargetMaterializationId" IS NOT NULL AND "replyHandoffId" IS NOT NULL
            AND "replyHandoffState" <> 'none')
        OR ("causeKind" IN ('trigger', 'manual', 'conversation')
            AND "replyContextEnvelope" IS NULL
            AND "replyHandoffActionPluginId" IS NULL AND "replyHandoffActionLocalId" IS NULL
            AND "replyHandoffTargetMachineId" IS NULL AND "replyHandoffTargetMachineInstallationId" IS NULL
            AND "replyHandoffTargetMaterializationId" IS NULL AND "replyHandoffId" IS NULL
            AND "replyHandoffState" = 'none' AND "replyHandoffAttempt" = 0
            AND "replyHandoffDueAt" IS NULL AND "replyHandoffReceiptEnvelope" IS NULL)
    );

CREATE TABLE "AutomationEventCatalogState" (
    "accountId" TEXT NOT NULL,
    "eventSourceDefinitionsRevision" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "AutomationEventCatalogState_pkey" PRIMARY KEY ("accountId"),
    CONSTRAINT "AutomationEventCatalogState_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AutomationEventSourceStatus" (
    "triggerId" TEXT NOT NULL,
    "eventPluginId" TEXT NOT NULL,
    "eventLocalId" TEXT NOT NULL,
    "sourceSelectorId" TEXT NOT NULL,
    "triggerRevision" INTEGER NOT NULL,
    "reporterMachineId" TEXT NOT NULL,
    "reporterMachineInstallationId" TEXT NOT NULL,
    "reporterMaterializationId" TEXT NOT NULL,
    "reporterImmutableGenerationId" VARCHAR(256) NOT NULL,
    "state" "AutomationEventSourceStatusState" NOT NULL,
    "code" TEXT,
    "lastObservedAt" TIMESTAMP(3),
    "lastDispositionAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "observedCount" INTEGER NOT NULL DEFAULT 0,
    "admittedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AutomationEventSourceStatus_pkey" PRIMARY KEY ("triggerId"),
    CONSTRAINT "AutomationEventSourceStatus_triggerId_fkey"
        FOREIGN KEY ("triggerId") REFERENCES "AutomationTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AutomationEventSourceCatalogStatus" (
    "accountId" TEXT NOT NULL,
    "eventPluginId" TEXT NOT NULL,
    "reporterMachineId" TEXT NOT NULL,
    "reporterMachineInstallationId" TEXT NOT NULL,
    "reporterMaterializationId" TEXT NOT NULL,
    "reporterImmutableGenerationId" VARCHAR(256) NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "observedRevision" BIGINT NOT NULL,
    "adoptedRevision" BIGINT,
    "state" "AutomationEventSourceCatalogStatusState" NOT NULL,
    "scanStartedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AutomationEventSourceCatalogStatus_pkey"
        PRIMARY KEY ("accountId", "eventPluginId", "reporterMaterializationId", "scopeKey"),
    CONSTRAINT "AutomationEventSourceCatalogStatus_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AutomationRunAssignment" (
    "runId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AutomationRunAssignment_pkey" PRIMARY KEY ("runId", "machineId"),
    CONSTRAINT "AutomationRunAssignment_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AutomationWorkerClaimReceipt" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "machineInstallationId" TEXT NOT NULL,
    "runId" TEXT,
    "claimedAttempt" INTEGER,
    "accountCurrentnessWitnessJson" TEXT,
    "claimResultJson" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationWorkerClaimReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutomationWorkerClaimReceipt_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationWorkerClaimReceipt_outcome_check" CHECK (
        ("runId" IS NULL AND "claimedAttempt" IS NULL AND "accountCurrentnessWitnessJson" IS NULL)
        OR ("runId" IS NOT NULL AND "claimedAttempt" IS NOT NULL AND "claimedAttempt" > 0
            AND "accountCurrentnessWitnessJson" IS NOT NULL)
    )
);

INSERT INTO "AutomationRunAssignment" ("runId", "machineId", "priority")
SELECT run."id", assignment."machineId", assignment."priority"
FROM "AutomationRun" AS run
JOIN "AutomationAssignment" AS assignment ON assignment."automationId" = run."automationId"
WHERE assignment."enabled" = true;

ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_triggerId_occurrenceKey_key"
        UNIQUE ("triggerId", "occurrenceKey");
ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_automationId_causeKind_occurrenceKey_key"
        UNIQUE ("automationId", "causeKind", "occurrenceKey");
CREATE INDEX "AutomationTrigger_automationId_enabled_updatedAt_idx"
ON "AutomationTrigger"("automationId", "enabled", "updatedAt" DESC);
CREATE INDEX "AutomationTrigger_event_lookup_idx"
ON "AutomationTrigger"("enabled", "kind", "eventPluginId", "eventLocalId");
CREATE INDEX "AutomationTrigger_watcher_lookup_idx"
ON "AutomationTrigger"("enabled", "watcherMachineId", "watcherMaterializationId");
CREATE INDEX "AutomationTrigger_schedule_due_idx"
ON "AutomationTrigger"("kind", "enabled", "deletedAt", "nextRunAt", "id");
CREATE INDEX "AutomationTrigger_session_lifecycle_lookup_idx"
ON "AutomationTrigger"("sourceSessionId", "sourceTurnId");
CREATE INDEX "AutomationRun_accountId_causeKind_state_idx"
ON "AutomationRun"("accountId", "causeKind", "state");
CREATE INDEX "AutomationRun_triggerId_state_idx"
ON "AutomationRun"("triggerId", "state");
CREATE INDEX "AutomationRun_replyHandoffState_replyHandoffDueAt_idx"
ON "AutomationRun"("replyHandoffState", "replyHandoffDueAt");
CREATE INDEX "AutomationRunAssignment_machineId_priority_idx"
ON "AutomationRunAssignment"("machineId", "priority");
CREATE INDEX "AutomationWorkerClaimReceipt_accountId_machineId_idx"
ON "AutomationWorkerClaimReceipt"("accountId", "machineId");
CREATE INDEX "AutomationWorkerClaimReceipt_expiresAt_idx"
ON "AutomationWorkerClaimReceipt"("expiresAt");
CREATE INDEX "AutomationEventSourceStatus_state_nextRetryAt_idx"
ON "AutomationEventSourceStatus"("state", "nextRetryAt");
CREATE INDEX "AutomationEventSourceCatalogStatus_state_reportedAt_idx"
ON "AutomationEventSourceCatalogStatus"("state", "reportedAt");
