ALTER TABLE "Automation" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Automation" ADD COLUMN "triggerKind" TEXT NOT NULL DEFAULT 'schedule';
ALTER TABLE "Automation" ADD COLUMN "triggerEventPluginId" TEXT;
ALTER TABLE "Automation" ADD COLUMN "triggerEventLocalId" TEXT;
ALTER TABLE "Automation" ADD COLUMN "triggerSourceSelectorId" TEXT;
ALTER TABLE "Automation" ADD COLUMN "triggerSourceContractVersion" INTEGER;
ALTER TABLE "Automation" ADD COLUMN "triggerObservationTransport" TEXT;
ALTER TABLE "Automation" ADD COLUMN "triggerWebhookEndpointId" TEXT;
ALTER TABLE "Automation" ADD COLUMN "triggerObservationStartsAt" DATETIME;
ALTER TABLE "Automation" ADD COLUMN "watcherMachineId" TEXT;
ALTER TABLE "Automation" ADD COLUMN "watcherMachineInstallationId" TEXT;
ALTER TABLE "Automation" ADD COLUMN "watcherPluginId" TEXT;
ALTER TABLE "Automation" ADD COLUMN "watcherMaterializationId" TEXT;
ALTER TABLE "Automation" ADD COLUMN "triggerDefinitionEnvelope" TEXT;

-- The preview predecessor represented manual definitions as a schedule arm.
-- Adopt those rows into the V3 trigger union before rebuilding its table.
ALTER TABLE "AutomationRun" ADD COLUMN "originKind" TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE "AutomationRun" ADD COLUMN "originOccurredAt" DATETIME;
ALTER TABLE "AutomationRun" ADD COLUMN "occurrenceKey" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "occurrenceEvidenceEqualityTag" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "originSourceSelectorId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "triggerEvidenceEnvelope" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "executionInputEnvelope" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "executionDispatchState" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "executionAttempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AutomationRun" ADD COLUMN "executionDispatchCommittedAt" DATETIME;
ALTER TABLE "AutomationRun" ADD COLUMN "executionDispatchDueAt" DATETIME;
ALTER TABLE "AutomationRun" ADD COLUMN "executionNativeRunId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "executionNativeCallId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "executionNativeSidechainId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "resultEnvelope" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "replyContextEnvelope" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffActionPluginId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffActionLocalId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffTargetMachineId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffTargetMachineInstallationId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffTargetMaterializationId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffId" TEXT;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffState" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffAttempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffDueAt" DATETIME;
ALTER TABLE "AutomationRun" ADD COLUMN "replyHandoffReceiptEnvelope" TEXT;

UPDATE "AutomationRun"
SET "originKind" = 'manual'
WHERE "automationId" IN (
    SELECT "id" FROM "Automation" WHERE "scheduleKind" = 'manual'
);

UPDATE "AutomationRun"
SET "resultEnvelope" = json_object(
    't', 'legacySummaryCiphertext',
    'c', "summaryCiphertext"
)
WHERE "summaryCiphertext" IS NOT NULL;

CREATE TABLE "AutomationEventCatalogState" (
    "accountId" TEXT NOT NULL PRIMARY KEY,
    "eventSourceDefinitionsRevision" BIGINT NOT NULL DEFAULT 0,
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
    "state" TEXT NOT NULL,
    "code" TEXT,
    "lastObservedAt" DATETIME,
    "lastDispositionAt" DATETIME,
    "nextRetryAt" DATETIME,
    "observedCount" INTEGER NOT NULL DEFAULT 0,
    "admittedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
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
    "state" TEXT NOT NULL,
    "scanStartedAt" DATETIME,
    "nextRetryAt" DATETIME,
    "reportedAt" DATETIME NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("accountId", "eventPluginId", "reporterMaterializationId", "scopeKey"),
    CONSTRAINT "AutomationEventSourceCatalogStatus_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- SQLite cannot alter a NOT NULL column or a foreign-key action in place.
-- Rebuild only the two canonical owners, preserving every existing row and
-- index while retaining the incumbent origin-time projection and Runs when
-- their Automation is soft-deleted.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Automation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" DATETIME,
    "scheduleKind" TEXT,
    "scheduleExpr" TEXT,
    "everyMs" INTEGER,
    "timezone" TEXT,
    "targetType" TEXT NOT NULL,
    "templateCiphertext" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 0,
    "triggerKind" TEXT NOT NULL DEFAULT 'schedule',
    "triggerEventPluginId" TEXT,
    "triggerEventLocalId" TEXT,
    "triggerSourceSelectorId" TEXT,
    "triggerSourceContractVersion" INTEGER,
    "triggerObservationTransport" TEXT,
    "triggerWebhookEndpointId" TEXT,
    "triggerObservationStartsAt" DATETIME,
    "watcherMachineId" TEXT,
    "watcherMachineInstallationId" TEXT,
    "watcherPluginId" TEXT,
    "watcherMaterializationId" TEXT,
    "triggerDefinitionEnvelope" TEXT,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Automation_trigger_arm_check"
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
        ),
    CONSTRAINT "Automation_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Automation" (
    "id", "accountId", "name", "description", "enabled", "deletedAt",
    "scheduleKind", "scheduleExpr", "everyMs", "timezone", "targetType",
    "templateCiphertext", "templateVersion", "triggerKind",
    "triggerEventPluginId", "triggerEventLocalId", "triggerSourceSelectorId",
    "triggerSourceContractVersion", "triggerObservationTransport",
    "triggerWebhookEndpointId", "triggerObservationStartsAt", "watcherMachineId",
    "watcherMachineInstallationId", "watcherPluginId", "watcherMaterializationId",
    "triggerDefinitionEnvelope", "nextRunAt", "lastRunAt", "createdAt", "updatedAt"
)
SELECT
    "id", "accountId", "name", "description", "enabled", "deletedAt",
    "scheduleKind", "scheduleExpr", "everyMs", "timezone", "targetType",
    "templateCiphertext", "templateVersion", "triggerKind",
    "triggerEventPluginId", "triggerEventLocalId", "triggerSourceSelectorId",
    "triggerSourceContractVersion", "triggerObservationTransport",
    "triggerWebhookEndpointId", "triggerObservationStartsAt", "watcherMachineId",
    "watcherMachineInstallationId", "watcherPluginId", "watcherMaterializationId",
    "triggerDefinitionEnvelope", "nextRunAt", "lastRunAt", "createdAt", "updatedAt"
FROM "Automation";

DROP TABLE "Automation";
ALTER TABLE "new_Automation" RENAME TO "Automation";

UPDATE "Automation"
SET
    "triggerKind" = 'manual',
    "scheduleKind" = NULL,
    "scheduleExpr" = NULL,
    "everyMs" = NULL,
    "timezone" = NULL,
    "nextRunAt" = NULL
WHERE "scheduleKind" = 'manual';

CREATE TABLE "new_AutomationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "automationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "originKind" TEXT NOT NULL DEFAULT 'scheduled',
    "originOccurredAt" DATETIME,
    "occurrenceKey" TEXT,
    "idempotencyKey" TEXT,
    "occurrenceEvidenceEqualityTag" TEXT,
    "originSourceSelectorId" TEXT,
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
    CONSTRAINT "AutomationRun_origin_arm_check"
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
                        COALESCE(
                            json_extract(
                                CASE
                                    WHEN json_valid("triggerEvidenceEnvelope") THEN "triggerEvidenceEnvelope"
                                    ELSE NULL
                                END,
                                '$.t'
                            ) = 'plain',
                            0
                        )
                        AND "occurrenceEvidenceEqualityTag" IS NULL
                    )
                    OR
                    (
                        COALESCE(
                            json_extract(
                                CASE
                                    WHEN json_valid("triggerEvidenceEnvelope") THEN "triggerEvidenceEnvelope"
                                    ELSE NULL
                                END,
                                '$.t'
                            ) = 'encrypted',
                            0
                        )
                        AND "occurrenceEvidenceEqualityTag" IS NOT NULL
                        AND length("occurrenceEvidenceEqualityTag") = 43
                        AND "occurrenceEvidenceEqualityTag" NOT GLOB '*[^A-Za-z0-9_-]*'
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
                        COALESCE(
                            json_extract(
                                CASE
                                    WHEN json_valid("triggerEvidenceEnvelope") THEN "triggerEvidenceEnvelope"
                                    ELSE NULL
                                END,
                                '$.t'
                            ) = 'plain',
                            0
                        )
                        AND "occurrenceEvidenceEqualityTag" IS NULL
                    )
                    OR
                    (
                        COALESCE(
                            json_extract(
                                CASE
                                    WHEN json_valid("triggerEvidenceEnvelope") THEN "triggerEvidenceEnvelope"
                                    ELSE NULL
                                END,
                                '$.t'
                            ) = 'encrypted',
                            0
                        )
                        AND "occurrenceEvidenceEqualityTag" IS NOT NULL
                        AND length("occurrenceEvidenceEqualityTag") = 43
                        AND "occurrenceEvidenceEqualityTag" NOT GLOB '*[^A-Za-z0-9_-]*'
                    )
                )
            )
        ),
    CONSTRAINT "AutomationRun_reply_handoff_arm_check"
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
        ),
    CONSTRAINT "AutomationRun_automationId_fkey"
        FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_claimedByMachineId_fkey"
        FOREIGN KEY ("claimedByMachineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_producedSessionId_fkey"
        FOREIGN KEY ("producedSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_AutomationRun" (
    "id", "automationId", "accountId", "state", "originKind", "originOccurredAt", "occurrenceKey", "idempotencyKey",
    "occurrenceEvidenceEqualityTag", "originSourceSelectorId", "triggerEvidenceEnvelope",
    "executionInputEnvelope", "executionDispatchState", "executionAttempt",
    "executionDispatchCommittedAt", "executionDispatchDueAt", "executionNativeRunId",
    "executionNativeCallId", "executionNativeSidechainId", "resultEnvelope",
    "replyContextEnvelope", "replyHandoffActionPluginId", "replyHandoffActionLocalId",
    "replyHandoffTargetMachineId", "replyHandoffTargetMachineInstallationId",
    "replyHandoffTargetMaterializationId", "replyHandoffId", "replyHandoffState",
    "replyHandoffAttempt", "replyHandoffDueAt", "replyHandoffReceiptEnvelope", "scheduledAt",
    "dueAt", "claimedAt", "startedAt", "finishedAt", "claimedByMachineId",
    "leaseExpiresAt", "attempt", "summaryCiphertext", "errorCode", "errorMessage",
    "producedSessionId", "createdAt", "updatedAt"
)
SELECT
    "id", "automationId", "accountId", "state", "originKind", "originOccurredAt", "occurrenceKey", "idempotencyKey",
    "occurrenceEvidenceEqualityTag", "originSourceSelectorId", "triggerEvidenceEnvelope",
    "executionInputEnvelope", "executionDispatchState", "executionAttempt",
    "executionDispatchCommittedAt", "executionDispatchDueAt", "executionNativeRunId",
    "executionNativeCallId", "executionNativeSidechainId", "resultEnvelope",
    "replyContextEnvelope", "replyHandoffActionPluginId", "replyHandoffActionLocalId",
    "replyHandoffTargetMachineId", "replyHandoffTargetMachineInstallationId",
    "replyHandoffTargetMaterializationId", "replyHandoffId", "replyHandoffState",
    "replyHandoffAttempt", "replyHandoffDueAt", "replyHandoffReceiptEnvelope", "scheduledAt",
    "dueAt", "claimedAt", "startedAt", "finishedAt", "claimedByMachineId",
    "leaseExpiresAt", "attempt", "summaryCiphertext", "errorCode", "errorMessage",
    "producedSessionId", "createdAt", "updatedAt"
FROM "AutomationRun";

DROP TABLE "AutomationRun";
ALTER TABLE "new_AutomationRun" RENAME TO "AutomationRun";

CREATE INDEX "Automation_accountId_enabled_updatedAt_idx"
ON "Automation"("accountId", "enabled", "updatedAt");
CREATE INDEX "Automation_accountId_nextRunAt_idx"
ON "Automation"("accountId", "nextRunAt");
CREATE INDEX "Automation_event_trigger_lookup_idx"
ON "Automation"("accountId", "enabled", "triggerKind", "triggerEventPluginId", "triggerEventLocalId");
CREATE INDEX "Automation_watcher_materialization_lookup_idx"
ON "Automation"("accountId", "enabled", "watcherMachineId", "watcherMaterializationId");

CREATE INDEX "AutomationRun_accountId_state_dueAt_idx"
ON "AutomationRun"("accountId", "state", "dueAt");
CREATE INDEX "AutomationRun_accountId_originKind_state_idx"
ON "AutomationRun"("accountId", "originKind", "state");
CREATE INDEX "AutomationRun_automationId_dueAt_idx"
ON "AutomationRun"("automationId", "dueAt");
CREATE INDEX "AutomationRun_claimedByMachineId_leaseExpiresAt_idx"
ON "AutomationRun"("claimedByMachineId", "leaseExpiresAt");
CREATE INDEX "AutomationRun_state_finishedAt_idx"
ON "AutomationRun"("state", "finishedAt");
CREATE INDEX "AutomationRun_state_dueAt_idx"
ON "AutomationRun"("state", "dueAt");
CREATE INDEX "AutomationRun_replyHandoffState_replyHandoffDueAt_idx"
ON "AutomationRun"("replyHandoffState", "replyHandoffDueAt");
CREATE UNIQUE INDEX "AutomationRun_automationId_occurrenceKey_key"
ON "AutomationRun"("automationId", "occurrenceKey");
CREATE UNIQUE INDEX "AutomationRun_automationId_idempotencyKey_key"
ON "AutomationRun"("automationId", "idempotencyKey");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

CREATE INDEX "AutomationEventSourceStatus_state_nextRetryAt_idx"
ON "AutomationEventSourceStatus"("state", "nextRetryAt");
CREATE INDEX "AutomationEventSourceCatalogStatus_state_reportedAt_idx"
ON "AutomationEventSourceCatalogStatus"("state", "reportedAt");
