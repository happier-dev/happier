-- Account-scoped Automation policy remains server-readable while private
-- Account settings may be E2EE. SQLite supports these constant defaults in place.
ALTER TABLE "Account" ADD COLUMN "automationMaxActiveRunsPerMachine" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "Account" ADD COLUMN "automationRunRetention" TEXT NOT NULL DEFAULT 'thirtyDays';

-- SQLite cannot replace a CHECK constraint in place. Rebuild AutomationRun
-- with the content-removal timestamp and preserve the existing indexes, keys,
-- revision values, and strict active Conversation handoff arm.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

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
    "contentRemovedAt" DATETIME,
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
                AND "contentRemovedAt" IS NULL
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
                "originKind" = 'conversation'
                AND "contentRemovedAt" IS NOT NULL
                AND "replyContextEnvelope" IS NULL
                AND "replyHandoffActionPluginId" IS NOT NULL
                AND "replyHandoffActionLocalId" IS NOT NULL
                AND "replyHandoffTargetMachineId" IS NOT NULL
                AND "replyHandoffTargetMachineInstallationId" IS NOT NULL
                AND "replyHandoffTargetMaterializationId" IS NOT NULL
                AND "replyHandoffId" IS NOT NULL
                AND "replyHandoffState" <> 'none'
                AND "replyHandoffReceiptEnvelope" IS NULL
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
    "leaseExpiresAt", "attempt", "revision", "summaryCiphertext", "errorCode", "errorMessage",
    "contentRemovedAt", "producedSessionId", "createdAt", "updatedAt"
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
    "leaseExpiresAt", "attempt", "revision", "summaryCiphertext", "errorCode", "errorMessage",
    NULL, "producedSessionId", "createdAt", "updatedAt"
FROM "AutomationRun";

DROP TABLE "AutomationRun";
ALTER TABLE "new_AutomationRun" RENAME TO "AutomationRun";

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
