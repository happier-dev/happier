-- Released V2 open Runs have no frozen recipe bytes. Refuse activation rather
-- than inventing them; the operator keeps the released worker active and
-- drains or cancels these rows before retrying the migration.
CREATE TEMP TABLE "_AutomationRun_open_frozen_input_preflight" (
    "ok" INTEGER NOT NULL,
    CONSTRAINT "AutomationRun_open_frozen_input_activation_required" CHECK ("ok" = 1)
);
INSERT INTO "_AutomationRun_open_frozen_input_preflight" ("ok")
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "AutomationRun" WHERE "state" IN ('queued', 'claimed', 'running')
) THEN 0 ELSE 1 END;
DROP TABLE "_AutomationRun_open_frozen_input_preflight";

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "AutomationTrigger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "automationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" DATETIME,
    "scheduleKind" TEXT,
    "scheduleExpr" TEXT,
    "everyMs" INTEGER,
    "timezone" TEXT,
    "nextRunAt" DATETIME,
    "eventPluginId" TEXT,
    "eventLocalId" TEXT,
    "sourceSelectorId" TEXT,
    "sourceContractVersion" INTEGER,
    "observationTransport" TEXT,
    "webhookEndpointId" TEXT,
    "observationStartsAt" DATETIME,
    "watcherMachineId" TEXT,
    "watcherMachineInstallationId" TEXT,
    "watcherPluginId" TEXT,
    "watcherMaterializationId" TEXT,
    "definitionEnvelope" TEXT,
    "sessionLifecycleEvent" TEXT,
    "sourceSessionId" TEXT,
    "sourceTurnId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutomationTrigger_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
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

INSERT INTO "AutomationTrigger" ("id", "automationId", "kind", "enabled", "scheduleKind", "scheduleExpr", "everyMs", "timezone", "nextRunAt", "createdAt", "updatedAt")
SELECT "id", "id", 'schedule', true, "scheduleKind", "scheduleExpr", "everyMs", "timezone", "nextRunAt", "createdAt", "updatedAt"
FROM "Automation";

CREATE TABLE "new_Automation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" DATETIME,
    "targetType" TEXT NOT NULL,
    "templateCiphertext" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Automation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Automation" ("id", "accountId", "name", "description", "enabled", "targetType", "templateCiphertext", "templateVersion", "lastRunAt", "createdAt", "updatedAt")
SELECT "id", "accountId", "name", "description", "enabled", "targetType", "templateCiphertext", "templateVersion", "lastRunAt", "createdAt", "updatedAt" FROM "Automation";

CREATE TABLE "new_AutomationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "automationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "triggerId" TEXT,
    "causeKind" TEXT NOT NULL DEFAULT 'trigger',
    "causeTriggerKind" TEXT,
    "causeTriggerRevision" INTEGER,
    "causeEventPluginId" TEXT,
    "causeEventLocalId" TEXT,
    "causeOccurredAt" DATETIME,
    "causeScheduledFor" DATETIME,
    "causeSessionLifecycleEvent" TEXT,
    "causeSourceSessionId" TEXT,
    "causeSourceTurnId" TEXT,
    "occurrenceKey" TEXT,
    "idempotencyKey" TEXT,
    "occurrenceEvidenceEqualityTag" TEXT,
    "causeSourceSelectorId" TEXT,
    "triggerEvidenceEnvelope" TEXT,
    "executionInputEnvelope" TEXT,
    "executionDispatchState" TEXT,
    "executionAttempt" INTEGER NOT NULL DEFAULT 0,
    "executionDispatchCommittedAt" DATETIME,
    "executionDispatchDueAt" DATETIME,
    "executionNativeRunId" TEXT,
    "executionNativeCallId" TEXT,
    "executionNativeSidechainId" TEXT,
    "resultEnvelope" TEXT,
    "replyContextEnvelope" TEXT,
    "replyHandoffActionPluginId" TEXT,
    "replyHandoffActionLocalId" TEXT,
    "replyHandoffTargetMachineId" TEXT,
    "replyHandoffTargetMachineInstallationId" TEXT,
    "replyHandoffTargetMaterializationId" TEXT,
    "replyHandoffId" TEXT,
    "replyHandoffState" TEXT NOT NULL DEFAULT 'none',
    "replyHandoffAttempt" INTEGER NOT NULL DEFAULT 0,
    "replyHandoffDueAt" DATETIME,
    "replyHandoffReceiptEnvelope" TEXT,
    "scheduledAt" DATETIME NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "claimedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "claimedByMachineId" TEXT,
    "leaseExpiresAt" DATETIME,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "summaryCiphertext" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "producedSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_claimedByMachineId_fkey" FOREIGN KEY ("claimedByMachineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_producedSessionId_fkey" FOREIGN KEY ("producedSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_cause_arm_check" CHECK (
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
                    AND ((json_valid("triggerEvidenceEnvelope") AND json_extract("triggerEvidenceEnvelope", '$.t') = 'plain' AND "occurrenceEvidenceEqualityTag" IS NULL)
                        OR (json_valid("triggerEvidenceEnvelope") AND json_extract("triggerEvidenceEnvelope", '$.t') = 'encrypted'
                            AND "occurrenceEvidenceEqualityTag" IS NOT NULL AND length("occurrenceEvidenceEqualityTag") = 43
                            AND "occurrenceEvidenceEqualityTag" NOT GLOB '*[^A-Za-z0-9_-]*')))
                OR ("causeTriggerKind" = 'sessionLifecycle' AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
                    AND "causeScheduledFor" IS NULL
                    AND "causeSessionLifecycleEvent" IS NOT NULL
                    AND "causeSessionLifecycleEvent" = 'parentTurnCompleted' AND "causeSourceSessionId" IS NOT NULL
                    AND "causeSourceTurnId" IS NOT NULL AND "causeSourceSelectorId" IS NULL
                    AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL)
            ))
        OR ("causeKind" = 'manual' AND "triggerId" IS NULL AND "causeTriggerKind" IS NULL
            AND "causeTriggerRevision" IS NULL AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
            AND "causeOccurredAt" IS NOT NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL
            AND "causeSourceTurnId" IS NULL AND "occurrenceKey" IS NULL AND "causeSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL)
        OR ("causeKind" = 'conversation' AND "idempotencyKey" IS NULL
            AND "triggerId" IS NULL AND "causeTriggerKind" IS NULL
            AND "causeTriggerRevision" IS NULL AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
            AND "causeOccurredAt" IS NOT NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL
            AND "causeSourceTurnId" IS NULL AND "occurrenceKey" IS NOT NULL AND "causeSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NOT NULL
            AND ((json_valid("triggerEvidenceEnvelope") AND json_extract("triggerEvidenceEnvelope", '$.t') = 'plain' AND "occurrenceEvidenceEqualityTag" IS NULL)
                OR (json_valid("triggerEvidenceEnvelope") AND json_extract("triggerEvidenceEnvelope", '$.t') = 'encrypted'
                    AND "occurrenceEvidenceEqualityTag" IS NOT NULL AND length("occurrenceEvidenceEqualityTag") = 43
                    AND "occurrenceEvidenceEqualityTag" NOT GLOB '*[^A-Za-z0-9_-]*')))
    ),
    CONSTRAINT "AutomationRun_execution_input_arm_check" CHECK (
        "state" NOT IN ('queued', 'claimed', 'running') OR "executionInputEnvelope" IS NOT NULL
    ),
    CONSTRAINT "AutomationRun_reply_handoff_arm_check" CHECK (
        ("causeKind" = 'conversation' AND "replyContextEnvelope" IS NOT NULL AND "replyHandoffActionPluginId" IS NOT NULL AND "replyHandoffActionLocalId" IS NOT NULL AND "replyHandoffTargetMachineId" IS NOT NULL AND "replyHandoffTargetMachineInstallationId" IS NOT NULL AND "replyHandoffTargetMaterializationId" IS NOT NULL AND "replyHandoffId" IS NOT NULL AND "replyHandoffState" <> 'none')
        OR ("causeKind" IN ('trigger', 'manual', 'conversation') AND "replyContextEnvelope" IS NULL AND "replyHandoffActionPluginId" IS NULL AND "replyHandoffActionLocalId" IS NULL AND "replyHandoffTargetMachineId" IS NULL AND "replyHandoffTargetMachineInstallationId" IS NULL AND "replyHandoffTargetMaterializationId" IS NULL AND "replyHandoffId" IS NULL AND "replyHandoffState" = 'none' AND "replyHandoffAttempt" = 0 AND "replyHandoffDueAt" IS NULL AND "replyHandoffReceiptEnvelope" IS NULL)
    )
);

INSERT INTO "new_AutomationRun" ("id", "automationId", "accountId", "state", "triggerId", "causeKind", "causeTriggerKind", "causeTriggerRevision", "causeOccurredAt", "causeScheduledFor", "occurrenceKey", "idempotencyKey", "resultEnvelope", "scheduledAt", "dueAt", "claimedAt", "startedAt", "finishedAt", "claimedByMachineId", "leaseExpiresAt", "attempt", "summaryCiphertext", "errorCode", "errorMessage", "producedSessionId", "createdAt", "updatedAt")
SELECT run."id", run."automationId", run."accountId", run."state",
    CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt" THEN run."automationId" ELSE NULL END,
    CASE WHEN run."idempotencyKey" IS NOT NULL OR run."dueAt" = run."scheduledAt" THEN 'manual' ELSE 'trigger' END,
    CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt" THEN 'schedule' ELSE NULL END,
    CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt" THEN 0 ELSE NULL END,
    CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt" THEN run."dueAt" ELSE run."createdAt" END,
    CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt" THEN run."dueAt" ELSE NULL END,
    CASE WHEN run."idempotencyKey" IS NULL AND run."dueAt" <> run."scheduledAt"
        THEN substr(run."id" || '_' || run."automationId" || '___________________________________________', 1, 43)
        ELSE NULL END,
    run."idempotencyKey",
    CASE WHEN run."summaryCiphertext" IS NOT NULL THEN json_object('t', 'legacySummaryCiphertext', 'c', run."summaryCiphertext") ELSE NULL END,
    run."scheduledAt", run."dueAt", run."claimedAt", run."startedAt", run."finishedAt", run."claimedByMachineId", run."leaseExpiresAt", run."attempt", run."summaryCiphertext", run."errorCode", run."errorMessage", run."producedSessionId", run."createdAt", run."updatedAt"
FROM "AutomationRun" AS run JOIN "Automation" AS definition ON definition."id" = run."automationId";

DROP TABLE "AutomationRun";
ALTER TABLE "new_AutomationRun" RENAME TO "AutomationRun";
DROP TABLE "Automation";
ALTER TABLE "new_Automation" RENAME TO "Automation";

CREATE TABLE "AutomationEventCatalogState" (
    "accountId" TEXT NOT NULL PRIMARY KEY,
    "eventSourceDefinitionsRevision" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "AutomationEventCatalogState_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AutomationEventSourceStatus" (
    "triggerId" TEXT NOT NULL PRIMARY KEY,
    "eventPluginId" TEXT NOT NULL,
    "eventLocalId" TEXT NOT NULL,
    "sourceSelectorId" TEXT NOT NULL,
    "triggerRevision" INTEGER NOT NULL,
    "reporterMachineId" TEXT NOT NULL,
    "reporterMachineInstallationId" TEXT NOT NULL,
    "reporterMaterializationId" TEXT NOT NULL,
    "reporterImmutableGenerationId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "code" TEXT,
    "lastObservedAt" DATETIME,
    "lastDispositionAt" DATETIME,
    "nextRetryAt" DATETIME,
    "observedCount" INTEGER NOT NULL DEFAULT 0,
    "admittedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AutomationEventSourceStatus_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "AutomationTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AutomationEventSourceCatalogStatus" (
    "accountId" TEXT NOT NULL,
    "eventPluginId" TEXT NOT NULL,
    "reporterMachineId" TEXT NOT NULL,
    "reporterMachineInstallationId" TEXT NOT NULL,
    "reporterMaterializationId" TEXT NOT NULL,
    "reporterImmutableGenerationId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "observedRevision" BIGINT NOT NULL,
    "adoptedRevision" BIGINT,
    "state" TEXT NOT NULL,
    "scanStartedAt" DATETIME,
    "nextRetryAt" DATETIME,
    "reportedAt" DATETIME NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("accountId", "eventPluginId", "reporterMaterializationId", "scopeKey"),
    CONSTRAINT "AutomationEventSourceCatalogStatus_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AutomationRunAssignment" (
    "runId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("runId", "machineId"),
    CONSTRAINT "AutomationRunAssignment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AutomationWorkerClaimReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "machineInstallationId" TEXT NOT NULL,
    "runId" TEXT,
    "claimedAttempt" INTEGER,
    "accountCurrentnessWitnessJson" TEXT,
    "claimResultJson" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationWorkerClaimReceipt_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationWorkerClaimReceipt_outcome_check" CHECK (
        ("runId" IS NULL AND "claimedAttempt" IS NULL AND "accountCurrentnessWitnessJson" IS NULL)
        OR ("runId" IS NOT NULL AND "claimedAttempt" IS NOT NULL AND "claimedAttempt" > 0 AND "accountCurrentnessWitnessJson" IS NOT NULL)
    )
);
INSERT INTO "AutomationRunAssignment" ("runId", "machineId", "priority")
SELECT run."id", assignment."machineId", assignment."priority"
FROM "AutomationRun" AS run JOIN "AutomationAssignment" AS assignment ON assignment."automationId" = run."automationId"
WHERE assignment."enabled" = true;

CREATE INDEX "Automation_accountId_enabled_updatedAt_idx" ON "Automation"("accountId", "enabled", "updatedAt");
CREATE INDEX "AutomationTrigger_automationId_enabled_updatedAt_idx" ON "AutomationTrigger"("automationId", "enabled", "updatedAt");
CREATE INDEX "AutomationTrigger_event_lookup_idx" ON "AutomationTrigger"("enabled", "kind", "eventPluginId", "eventLocalId");
CREATE INDEX "AutomationTrigger_watcher_lookup_idx" ON "AutomationTrigger"("enabled", "watcherMachineId", "watcherMaterializationId");
CREATE INDEX "AutomationTrigger_schedule_due_idx" ON "AutomationTrigger"("kind", "enabled", "deletedAt", "nextRunAt", "id");
CREATE INDEX "AutomationTrigger_session_lifecycle_lookup_idx" ON "AutomationTrigger"("sourceSessionId", "sourceTurnId");
CREATE INDEX "AutomationRun_accountId_state_dueAt_idx" ON "AutomationRun"("accountId", "state", "dueAt");
CREATE INDEX "AutomationRun_accountId_causeKind_state_idx" ON "AutomationRun"("accountId", "causeKind", "state");
CREATE INDEX "AutomationRun_automationId_dueAt_idx" ON "AutomationRun"("automationId", "dueAt");
CREATE INDEX "AutomationRun_claimedByMachineId_leaseExpiresAt_idx" ON "AutomationRun"("claimedByMachineId", "leaseExpiresAt");
CREATE INDEX "AutomationRun_state_finishedAt_idx" ON "AutomationRun"("state", "finishedAt");
CREATE INDEX "AutomationRun_state_dueAt_idx" ON "AutomationRun"("state", "dueAt");
CREATE INDEX "AutomationRun_replyHandoffState_replyHandoffDueAt_idx" ON "AutomationRun"("replyHandoffState", "replyHandoffDueAt");
CREATE INDEX "AutomationRun_triggerId_state_idx" ON "AutomationRun"("triggerId", "state");
CREATE UNIQUE INDEX "AutomationRun_triggerId_occurrenceKey_key" ON "AutomationRun"("triggerId", "occurrenceKey");
CREATE UNIQUE INDEX "AutomationRun_automationId_causeKind_occurrenceKey_key" ON "AutomationRun"("automationId", "causeKind", "occurrenceKey");
CREATE UNIQUE INDEX "AutomationRun_automationId_idempotencyKey_key" ON "AutomationRun"("automationId", "idempotencyKey");
CREATE INDEX "AutomationRunAssignment_machineId_priority_idx" ON "AutomationRunAssignment"("machineId", "priority");
CREATE INDEX "AutomationWorkerClaimReceipt_accountId_machineId_idx" ON "AutomationWorkerClaimReceipt"("accountId", "machineId");
CREATE INDEX "AutomationWorkerClaimReceipt_expiresAt_idx" ON "AutomationWorkerClaimReceipt"("expiresAt");
CREATE INDEX "AutomationEventSourceStatus_state_nextRetryAt_idx" ON "AutomationEventSourceStatus"("state", "nextRetryAt");
CREATE INDEX "AutomationEventSourceCatalogStatus_state_reportedAt_idx" ON "AutomationEventSourceCatalogStatus"("state", "reportedAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
