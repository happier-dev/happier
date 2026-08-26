CREATE TYPE "AutomationTriggerKind" AS ENUM ('schedule', 'pluginEvent', 'sessionLifecycle');
CREATE TYPE "AutomationSessionLifecycleEvent" AS ENUM ('parentTurnCompleted');
CREATE TYPE "AutomationObservationTransport" AS ENUM ('checkpointedPull', 'durablePush');
CREATE TYPE "AutomationRunCauseKind" AS ENUM ('trigger', 'manual', 'conversation');
CREATE TYPE "AutomationExecutionDispatchState" AS ENUM ('notStarted', 'dispatchPermitted', 'retryWaiting', 'started', 'settled', 'outcomeUnknown');
CREATE TYPE "AutomationRunReplyHandoffState" AS ENUM ('none', 'awaitingResult', 'ready', 'handingOff', 'accepted', 'suppressed', 'blocked');
CREATE TYPE "AutomationEventSourceStatusState" AS ENUM ('uninitialized', 'baselined', 'observing', 'backingOff', 'attention');
CREATE TYPE "AutomationEventSourceCatalogStatusState" AS ENUM ('current', 'reconciling', 'reconciliationLate');

-- This local-only migration expands the closed Automation target union before
-- current strict recipes may persist the detached execution arm.
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
    ADD COLUMN "causeOccurredAt" TIMESTAMP(3),
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
    ADD COLUMN "contentRemovedAt" TIMESTAMP(3),
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
    "filterEnvelope" TEXT,
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
        ("kind" = 'schedule' AND "scheduleKind" IS NOT NULL
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "filterEnvelope" IS NULL AND "definitionEnvelope" IS NULL
            AND "sessionLifecycleEvent" IS NULL AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL)
        OR
        ("kind" = 'pluginEvent' AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL
            AND "everyMs" IS NULL AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NOT NULL AND "eventLocalId" IS NOT NULL
            AND "sourceSelectorId" IS NOT NULL AND "sourceContractVersion" IS NOT NULL
            AND "observationTransport" IS NOT NULL AND "definitionEnvelope" IS NOT NULL
            AND "sessionLifecycleEvent" IS NULL AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL
            AND (("observationTransport" = 'checkpointedPull' AND "webhookEndpointId" IS NULL
                    AND "observationStartsAt" IS NULL
                    AND (("watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
                            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL)
                        OR ("watcherMachineId" IS NOT NULL AND "watcherMachineInstallationId" IS NOT NULL
                            AND "watcherPluginId" IS NOT NULL AND "watcherMaterializationId" IS NOT NULL)))
                OR ("observationTransport" = 'durablePush' AND "webhookEndpointId" IS NOT NULL
                    AND "observationStartsAt" IS NOT NULL AND "watcherMachineId" IS NULL
                    AND "watcherMachineInstallationId" IS NULL AND "watcherPluginId" IS NULL
                    AND "watcherMaterializationId" IS NULL)))
        OR
        ("kind" = 'sessionLifecycle' AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL
            AND "everyMs" IS NULL AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "filterEnvelope" IS NULL AND "definitionEnvelope" IS NULL
            AND "sessionLifecycleEvent" = 'parentTurnCompleted'
            AND "sourceSessionId" IS NOT NULL AND "sourceTurnId" IS NOT NULL)
    )
);

INSERT INTO "AutomationTrigger" (
    "id", "automationId", "kind", "enabled", "scheduleKind", "scheduleExpr",
    "everyMs", "timezone", "nextRunAt", "createdAt", "updatedAt"
)
SELECT "id", "id", 'schedule', "enabled", "scheduleKind", "scheduleExpr",
    "everyMs", "timezone", "nextRunAt", "createdAt", "updatedAt"
FROM "Automation";

UPDATE "AutomationRun"
SET "triggerId" = "automationId", "causeTriggerKind" = 'schedule',
    "causeTriggerRevision" = 0, "causeOccurredAt" = "scheduledAt";

ALTER TABLE "Automation"
    DROP COLUMN "scheduleKind", DROP COLUMN "scheduleExpr", DROP COLUMN "everyMs",
    DROP COLUMN "timezone", DROP COLUMN "nextRunAt";

-- A retained Run is the durable execution/history owner. Automations become
-- soft-deleted while Runs remain, rather than cascading that history away.
ALTER TABLE "AutomationRun"
    DROP CONSTRAINT "AutomationRun_automationId_fkey";
ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_automationId_fkey"
        FOREIGN KEY ("automationId") REFERENCES "Automation"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- The definition-trigger and Run-origin unions are physical constraints. Keep impossible
-- combinations out of the database even if a future caller bypasses an
-- application-level validator.
ALTER TABLE "Automation"
    ADD CONSTRAINT "Automation_trigger_arm_check"
    CHECK (
        (
            "triggerKind" = 'schedule'
            AND "scheduleKind" IS NOT NULL
            AND "triggerEventPluginId" IS NULL
            AND "triggerEventLocalId" IS NULL
            AND "triggerSourceSelectorId" IS NULL
            AND "triggerSourceContractVersion" IS NULL
            AND "triggerObservationTransport" IS NULL
            AND "triggerWebhookEndpointId" IS NULL
            AND "triggerObservationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL
            AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL
            AND "watcherMaterializationId" IS NULL
            AND "triggerDefinitionEnvelope" IS NULL
        )
        OR
        (
            "triggerKind" = 'manual'
            AND "scheduleKind" IS NULL
            AND "triggerEventPluginId" IS NULL
            AND "triggerEventLocalId" IS NULL
            AND "triggerSourceSelectorId" IS NULL
            AND "triggerSourceContractVersion" IS NULL
            AND "triggerObservationTransport" IS NULL
            AND "triggerWebhookEndpointId" IS NULL
            AND "triggerObservationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL
            AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL
            AND "watcherMaterializationId" IS NULL
            AND "triggerDefinitionEnvelope" IS NULL
        )
        OR
        (
            "triggerKind" = 'pluginEvent'
            AND "scheduleKind" IS NULL
            AND "triggerEventPluginId" IS NOT NULL
            AND "triggerEventLocalId" IS NOT NULL
            AND "triggerSourceSelectorId" IS NOT NULL
            AND "triggerSourceContractVersion" IS NOT NULL
            AND "triggerDefinitionEnvelope" IS NOT NULL
            AND (
                (
                    "triggerObservationTransport" = 'checkpointedPull'
                    AND "triggerWebhookEndpointId" IS NULL
                    AND "triggerObservationStartsAt" IS NULL
                    AND (
                        (
                            "watcherMachineId" IS NULL
                            AND "watcherMachineInstallationId" IS NULL
                            AND "watcherPluginId" IS NULL
                            AND "watcherMaterializationId" IS NULL
                        )
                        OR
                        (
                            "watcherMachineId" IS NOT NULL
                            AND "watcherMachineInstallationId" IS NOT NULL
                            AND "watcherPluginId" IS NOT NULL
                            AND "watcherMaterializationId" IS NOT NULL
                        )
                    )
                )
                OR
                (
                    "triggerObservationTransport" = 'durablePush'
                    AND "triggerWebhookEndpointId" IS NOT NULL
                    AND "triggerObservationStartsAt" IS NOT NULL
                    AND "watcherMachineId" IS NULL
                    AND "watcherMachineInstallationId" IS NULL
                    AND "watcherPluginId" IS NULL
                    AND "watcherMaterializationId" IS NULL
                )
            )
        )
    );

ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_origin_arm_check"
    CHECK (
        (
            "originKind" = 'scheduled'
            AND "originOccurredAt" IS NULL
            AND "occurrenceKey" IS NULL
            AND "occurrenceEvidenceEqualityTag" IS NULL
            AND "originSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NULL
        )
        OR
        (
            "originKind" = 'manual'
            AND "originOccurredAt" IS NULL
            AND "occurrenceEvidenceEqualityTag" IS NULL
            AND "originSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NULL
        )
        OR
        (
            "originKind" = 'pluginEvent'
            AND "originOccurredAt" IS NOT NULL
            AND "occurrenceKey" IS NOT NULL
            AND "originSourceSelectorId" IS NOT NULL
            AND "triggerEvidenceEnvelope" IS NOT NULL
            AND (
                (
                    COALESCE(("triggerEvidenceEnvelope"::jsonb ->> 't') = 'plain', FALSE)
                    AND "occurrenceEvidenceEqualityTag" IS NULL
                )
                OR
                (
                    COALESCE(("triggerEvidenceEnvelope"::jsonb ->> 't') = 'encrypted', FALSE)
                    AND "occurrenceEvidenceEqualityTag" IS NOT NULL
                    AND char_length("occurrenceEvidenceEqualityTag") = 43
                    AND "occurrenceEvidenceEqualityTag" ~ '^[A-Za-z0-9_-]{43}$'
                )
            )
        )
        OR
        (
            "originKind" = 'conversation'
            AND "originOccurredAt" IS NOT NULL
            AND "occurrenceKey" IS NOT NULL
            AND "originSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NOT NULL
            AND (
                (
                    COALESCE(("triggerEvidenceEnvelope"::jsonb ->> 't') = 'plain', FALSE)
                    AND "occurrenceEvidenceEqualityTag" IS NULL
                )
                OR
                (
                    COALESCE(("triggerEvidenceEnvelope"::jsonb ->> 't') = 'encrypted', FALSE)
                    AND "occurrenceEvidenceEqualityTag" IS NOT NULL
                    AND char_length("occurrenceEvidenceEqualityTag") = 43
                    AND "occurrenceEvidenceEqualityTag" ~ '^[A-Za-z0-9_-]{43}$'
                )
            )
        )
    );

ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_reply_handoff_arm_check"
    CHECK (
        (
            "originKind" = 'conversation'
            AND "replyContextEnvelope" IS NOT NULL
            AND "replyHandoffActionPluginId" IS NOT NULL
            AND "replyHandoffActionLocalId" IS NOT NULL
            AND "replyHandoffTargetMachineId" IS NOT NULL
            AND "replyHandoffTargetMachineInstallationId" IS NOT NULL
            AND "replyHandoffTargetMaterializationId" IS NOT NULL
            AND "replyHandoffId" IS NOT NULL
            AND "replyHandoffState" <> 'none'
        )
        OR
        (
            "originKind" IN ('scheduled', 'manual', 'pluginEvent', 'conversation')
            AND "replyContextEnvelope" IS NULL
            AND "replyHandoffActionPluginId" IS NULL
            AND "replyHandoffActionLocalId" IS NULL
            AND "replyHandoffTargetMachineId" IS NULL
            AND "replyHandoffTargetMachineInstallationId" IS NULL
            AND "replyHandoffTargetMaterializationId" IS NULL
            AND "replyHandoffId" IS NULL
            AND "replyHandoffState" = 'none'
            AND "replyHandoffAttempt" = 0
            AND "replyHandoffDueAt" IS NULL
            AND "replyHandoffReceiptEnvelope" IS NULL
        )
    );

UPDATE "AutomationRun"
SET "resultEnvelope" = json_build_object(
    't', 'legacySummaryCiphertext',
    'c', "summaryCiphertext"
)::text
WHERE "summaryCiphertext" IS NOT NULL;

CREATE TABLE "AutomationEventCatalogState" (
    "accountId" TEXT NOT NULL,
    "eventSourceDefinitionsRevision" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "AutomationEventCatalogState_pkey" PRIMARY KEY ("accountId"),
    CONSTRAINT "AutomationEventCatalogState_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AutomationEventSourceStatus" (
    "automationId" TEXT NOT NULL,
    "eventPluginId" TEXT NOT NULL,
    "eventLocalId" TEXT NOT NULL,
    "sourceSelectorId" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "reporterMachineId" TEXT NOT NULL,
    "reporterMachineInstallationId" TEXT NOT NULL,
    "reporterMaterializationId" TEXT NOT NULL,
    "state" "AutomationEventSourceStatusState" NOT NULL,
    "code" TEXT,
    "lastObservedAt" TIMESTAMP(3),
    "lastDispositionAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "observedCount" INTEGER NOT NULL DEFAULT 0,
    "admittedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AutomationEventSourceStatus_pkey"
        PRIMARY KEY ("automationId", "eventPluginId", "eventLocalId", "sourceSelectorId"),
    CONSTRAINT "AutomationEventSourceStatus_automationId_fkey"
        FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AutomationEventSourceCatalogStatus" (
    "accountId" TEXT NOT NULL,
    "eventPluginId" TEXT NOT NULL,
    "reporterMachineId" TEXT NOT NULL,
    "reporterMachineInstallationId" TEXT NOT NULL,
    "reporterMaterializationId" TEXT NOT NULL,
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

ALTER TABLE "AutomationRun"
    ADD CONSTRAINT "AutomationRun_automationId_occurrenceKey_key"
    UNIQUE ("automationId", "occurrenceKey");

CREATE INDEX "Automation_event_trigger_lookup_idx"
ON "Automation"("accountId", "enabled", "triggerKind", "triggerEventPluginId", "triggerEventLocalId");
CREATE INDEX "Automation_watcher_materialization_lookup_idx"
ON "Automation"("accountId", "enabled", "watcherMachineId", "watcherMaterializationId");
CREATE INDEX "AutomationRun_accountId_originKind_state_idx"
ON "AutomationRun"("accountId", "originKind", "state");
CREATE INDEX "AutomationRun_state_dueAt_idx"
ON "AutomationRun"("state", "dueAt");
CREATE INDEX "AutomationRun_replyHandoffState_replyHandoffDueAt_idx"
ON "AutomationRun"("replyHandoffState", "replyHandoffDueAt");
CREATE INDEX "AutomationEventSourceStatus_state_nextRetryAt_idx"
ON "AutomationEventSourceStatus"("state", "nextRetryAt");
CREATE INDEX "AutomationEventSourceCatalogStatus_state_reportedAt_idx"
ON "AutomationEventSourceCatalogStatus"("state", "reportedAt");
