-- Expand only the Session turn-start cause value; preserve every retained Run column, CHECK, FK and index.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_AutomationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "originKind" TEXT NOT NULL DEFAULT 'automation',
    "automationId" TEXT,
    "originSessionId" TEXT,
    "workflowAcceptedSnapshotEnvelope" TEXT,
    "sourceArtifactId" TEXT,
    "visibleTeamId" TEXT,
    "workflowCheckpointEnvelope" TEXT,
    "workflowCustodyState" TEXT,
    "workflowResumeRequestedRevision" INTEGER,
    "originDeliveryAckRevision" INTEGER,
    "accountId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "triggerId" TEXT,
    "causeKind" TEXT DEFAULT 'trigger',
    "causeTriggerKind" TEXT,
    "causeTriggerRevision" INTEGER,
    "causeEventPluginId" TEXT,
    "causeEventLocalId" TEXT,
    "causeOccurredAt" DATETIME,
    "causeScheduledFor" DATETIME,
    "causeSessionLifecycleEvent" TEXT,
    "causeSourceSessionId" TEXT,
    "causeSourceTurnId" TEXT,
    "causeRunLifecycleEvidenceJson" TEXT,
    "causeOriginRunId" TEXT,
    "causeSessionLifecycleRequestId" TEXT,
    "causeSessionLifecycleRequestKind" TEXT,
    "causeSessionLifecyclePolicyKind" TEXT,
    "causeSessionLifecycleConfiguredCount" INTEGER,
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
    "updatedAt" DATETIME NOT NULL, "automationScopeCaptured" BOOLEAN NOT NULL DEFAULT false, "automationScopeSessionId" TEXT, "attentionSeenFailureAt" DATETIME, "managedCreationId" TEXT REFERENCES "ManagedMachine"("id") ON DELETE SET NULL ON UPDATE CASCADE, "originDiscussionId" TEXT, "workflowDisplaySummaryEnvelope" TEXT, "resultEnvelopeBytes" BLOB, "workflowCheckpointEnvelopeBytes" BLOB,
    "causeActionEvidenceJson" TEXT,
    "causePluginEventEvidenceJson" TEXT,
    CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_originSessionId_fkey" FOREIGN KEY ("originSessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_claimedByMachineId_fkey" FOREIGN KEY ("claimedByMachineId") REFERENCES "Machine" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_producedSessionId_fkey" FOREIGN KEY ("producedSessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_archive_origin_arm_check" CHECK (
        "causeOriginRunId" IS NULL OR (
            "originKind" = 'automation' AND "causeKind" IS NOT NULL AND "causeKind" = 'trigger'
            AND "causeTriggerKind" IS NOT NULL AND "causeTriggerKind" = 'sessionLifecycle'
            AND "causeSessionLifecycleEvent" IS NOT NULL AND "causeSessionLifecycleEvent" = 'sessionArchived'
        )
    ),
    CONSTRAINT "AutomationRun_state_check" CHECK ("state" IN ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'dispatch_failed', 'skipped', 'missed', 'outcome_uncertain', 'pause_requested', 'paused', 'interrupted', 'waiting_for_review')),
    CONSTRAINT "AutomationRun_origin_kind_check" CHECK (
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
    ),
    CONSTRAINT "AutomationRun_cause_arm_check" CHECK ((((("originKind" = 'direct' OR (
        ("causeKind" = 'trigger' AND "idempotencyKey" IS NULL AND "causeTriggerKind" IS NOT NULL
            AND "triggerId" IS NOT NULL AND "causeTriggerRevision" IS NOT NULL
            AND "causeOccurredAt" IS NOT NULL AND "occurrenceKey" IS NOT NULL AND (
                ("causeTriggerKind" = 'schedule' AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
                    AND "causeScheduledFor" IS NOT NULL
                    AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL
                    AND "causeSessionLifecycleRequestId" IS NULL AND "causeSessionLifecycleRequestKind" IS NULL
                    AND "causeSessionLifecyclePolicyKind" IS NULL AND "causeSessionLifecycleConfiguredCount" IS NULL
                    AND "causeSourceSelectorId" IS NULL AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL)
                OR ("causeTriggerKind" = 'pluginEvent' AND "causeEventPluginId" IS NOT NULL AND "causeEventLocalId" IS NOT NULL
                    AND "causeScheduledFor" IS NULL
                    AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL
                    AND "causeSessionLifecycleRequestId" IS NULL AND "causeSessionLifecycleRequestKind" IS NULL
                    AND "causeSessionLifecyclePolicyKind" IS NULL AND "causeSessionLifecycleConfiguredCount" IS NULL
                    AND "causeSourceSelectorId" IS NOT NULL AND "triggerEvidenceEnvelope" IS NOT NULL
                    AND ((json_valid("triggerEvidenceEnvelope") AND json_extract("triggerEvidenceEnvelope", '$.t') = 'plain' AND "occurrenceEvidenceEqualityTag" IS NULL)
                        OR (json_valid("triggerEvidenceEnvelope") AND json_extract("triggerEvidenceEnvelope", '$.t') = 'encrypted'
                            AND "occurrenceEvidenceEqualityTag" IS NOT NULL AND length("occurrenceEvidenceEqualityTag") = 43
                            AND "occurrenceEvidenceEqualityTag" NOT GLOB '*[^A-Za-z0-9_-]*')))
                OR ("causeTriggerKind" = 'sessionLifecycle' AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
                    AND "causeScheduledFor" IS NULL
                    AND "causeSessionLifecycleEvent" IN ('parentTurnStarted', 'parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled', 'userActionRequired', 'sessionStarted', 'sessionArchived')
                    AND "causeSourceSessionId" IS NOT NULL
                    AND (("causeSessionLifecycleEvent" IN ('sessionStarted', 'sessionArchived') AND "causeSourceTurnId" IS NULL)
                        OR ("causeSessionLifecycleEvent" NOT IN ('sessionStarted', 'sessionArchived') AND "causeSourceTurnId" IS NOT NULL))
                    AND "causeSourceSelectorId" IS NULL
                    AND "causeSessionLifecyclePolicyKind" IN ('currentTurn', 'firstMatch', 'nextMatches', 'everyMatch')
                    AND (("causeSessionLifecycleEvent" = 'userActionRequired'
                            AND "causeSessionLifecycleRequestId" IS NOT NULL
                            AND "causeSessionLifecycleRequestKind" IN ('permission', 'user_action'))
                        OR ("causeSessionLifecycleEvent" <> 'userActionRequired'
                            AND "causeSessionLifecycleRequestId" IS NULL
                            AND "causeSessionLifecycleRequestKind" IS NULL))
                    AND (("causeSessionLifecyclePolicyKind" = 'nextMatches'
                            AND "causeSessionLifecycleConfiguredCount" > 0)
                        OR ("causeSessionLifecyclePolicyKind" <> 'nextMatches'
                            AND "causeSessionLifecycleConfiguredCount" IS NULL))
                    AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL)
            ))
        OR ("causeKind" = 'manual' AND "triggerId" IS NULL AND "causeTriggerKind" IS NULL
            AND "causeTriggerRevision" IS NULL AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
            AND "causeOccurredAt" IS NOT NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL
            AND "causeSourceTurnId" IS NULL AND "causeSessionLifecycleRequestId" IS NULL
            AND "causeSessionLifecycleRequestKind" IS NULL AND "causeSessionLifecyclePolicyKind" IS NULL
            AND "causeSessionLifecycleConfiguredCount" IS NULL
            AND ("occurrenceKey" IS NULL OR "idempotencyKey" IS NULL)
            AND "causeSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL)
        OR ("causeKind" = 'conversation' AND "idempotencyKey" IS NULL
            AND "causeTriggerKind" IS NULL
            AND "causeTriggerRevision" IS NULL AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL
            AND "causeOccurredAt" IS NOT NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL
            AND "causeSourceTurnId" IS NULL AND "causeSessionLifecycleRequestId" IS NULL
            AND "causeSessionLifecycleRequestKind" IS NULL AND "causeSessionLifecyclePolicyKind" IS NULL
            AND "causeSessionLifecycleConfiguredCount" IS NULL
            AND "occurrenceKey" IS NOT NULL AND "causeSourceSelectorId" IS NULL
            AND "triggerEvidenceEnvelope" IS NOT NULL
            AND ((json_valid("triggerEvidenceEnvelope") AND json_extract("triggerEvidenceEnvelope", '$.t') = 'plain' AND "occurrenceEvidenceEqualityTag" IS NULL)
                OR (json_valid("triggerEvidenceEnvelope") AND json_extract("triggerEvidenceEnvelope", '$.t') = 'encrypted'
                    AND "occurrenceEvidenceEqualityTag" IS NOT NULL AND length("occurrenceEvidenceEqualityTag") = 43
                    AND "occurrenceEvidenceEqualityTag" NOT GLOB '*[^A-Za-z0-9_-]*')))
    )) AND "causeRunLifecycleEvidenceJson" IS NULL) OR ("originKind" = 'automation' AND "causeKind" = 'trigger' AND "causeTriggerKind" = 'runLifecycle' AND "triggerId" IS NOT NULL AND "causeTriggerRevision" IS NOT NULL AND "causeOccurredAt" IS NOT NULL AND "occurrenceKey" IS NOT NULL AND "causeRunLifecycleEvidenceJson" IS NOT NULL AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL AND "causeSessionLifecycleRequestId" IS NULL AND "causeSessionLifecycleRequestKind" IS NULL AND "causeSessionLifecyclePolicyKind" IS NULL AND "causeSessionLifecycleConfiguredCount" IS NULL AND "causeSourceSelectorId" IS NULL AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL AND "idempotencyKey" IS NULL)) AND "causeActionEvidenceJson" IS NULL AND "causePluginEventEvidenceJson" IS NULL) OR (("originKind" = 'automation' AND "causeKind" = 'trigger'
        AND "causeTriggerKind" IS NOT NULL AND "causeTriggerKind" = 'action' AND "triggerId" IS NOT NULL
        AND "causeTriggerRevision" IS NOT NULL AND "causeOccurredAt" IS NOT NULL
        AND "occurrenceKey" IS NOT NULL AND "causeActionEvidenceJson" IS NOT NULL
        AND json_valid("causeActionEvidenceJson") AND json_type("causeActionEvidenceJson") = 'object'
        AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL AND "causeSessionLifecycleRequestId" IS NULL AND "causeSessionLifecycleRequestKind" IS NULL AND "causeSessionLifecyclePolicyKind" IS NULL AND "causeSessionLifecycleConfiguredCount" IS NULL AND "causeSourceSelectorId" IS NULL AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL AND "causeRunLifecycleEvidenceJson" IS NULL AND "causeOriginRunId" IS NULL AND "idempotencyKey" IS NULL) AND "causePluginEventEvidenceJson" IS NULL) OR ("originKind" = 'automation' AND "causeKind" = 'trigger'
        AND "causeTriggerKind" IS NOT NULL AND "causeTriggerKind" = 'pluginEvent' AND "triggerId" IS NOT NULL
        AND "causeTriggerRevision" IS NOT NULL AND "causeOccurredAt" IS NOT NULL
        AND "occurrenceKey" IS NOT NULL AND "causePluginEventEvidenceJson" IS NOT NULL
        AND json_valid("causePluginEventEvidenceJson") AND json_type("causePluginEventEvidenceJson") = 'object'
        AND "causeEventPluginId" IS NOT NULL AND "causeEventPluginId" = 'happier.machine.services'
        AND "causeEventLocalId" IS NOT NULL AND "causeEventLocalId" IN ('machine-offline', 'machine-online')
        AND "causeSourceSelectorId" IS NOT NULL
        AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL AND "causeSessionLifecycleRequestId" IS NULL AND "causeSessionLifecycleRequestKind" IS NULL AND "causeSessionLifecyclePolicyKind" IS NULL AND "causeSessionLifecycleConfiguredCount" IS NULL AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL AND "causeRunLifecycleEvidenceJson" IS NULL AND "causeOriginRunId" IS NULL AND "idempotencyKey" IS NULL
        AND "causeActionEvidenceJson" IS NULL)),
    CONSTRAINT "AutomationRun_execution_input_arm_check" CHECK (
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
    ),
    CONSTRAINT "AutomationRun_reply_handoff_arm_check" CHECK ("originKind" = 'direct' OR (
        ("causeKind" = 'conversation' AND "replyContextEnvelope" IS NOT NULL AND "replyHandoffActionPluginId" IS NOT NULL AND "replyHandoffActionLocalId" IS NOT NULL AND "replyHandoffTargetMachineId" IS NOT NULL AND "replyHandoffTargetMachineInstallationId" IS NOT NULL AND "replyHandoffTargetMaterializationId" IS NOT NULL AND "replyHandoffId" IS NOT NULL AND "replyHandoffState" <> 'none')
        OR ("causeKind" IN ('trigger', 'manual', 'conversation') AND "replyContextEnvelope" IS NULL AND "replyHandoffActionPluginId" IS NULL AND "replyHandoffActionLocalId" IS NULL AND "replyHandoffTargetMachineId" IS NULL AND "replyHandoffTargetMachineInstallationId" IS NULL AND "replyHandoffTargetMaterializationId" IS NULL AND "replyHandoffId" IS NULL AND "replyHandoffState" = 'none' AND "replyHandoffAttempt" = 0 AND "replyHandoffDueAt" IS NULL)
    ))
);

INSERT INTO "new_AutomationRun" ("id", "originKind", "automationId", "originSessionId", "workflowAcceptedSnapshotEnvelope", "sourceArtifactId", "visibleTeamId", "workflowCheckpointEnvelope", "workflowCustodyState", "workflowResumeRequestedRevision", "originDeliveryAckRevision", "accountId", "state", "triggerId", "causeKind", "causeTriggerKind", "causeTriggerRevision", "causeEventPluginId", "causeEventLocalId", "causeOccurredAt", "causeScheduledFor", "causeSessionLifecycleEvent", "causeSourceSessionId", "causeSourceTurnId", "causeRunLifecycleEvidenceJson", "causeOriginRunId", "causeSessionLifecycleRequestId", "causeSessionLifecycleRequestKind", "causeSessionLifecyclePolicyKind", "causeSessionLifecycleConfiguredCount", "occurrenceKey", "idempotencyKey", "occurrenceEvidenceEqualityTag", "causeSourceSelectorId", "triggerEvidenceEnvelope", "executionInputEnvelope", "executionDispatchState", "executionAttempt", "executionDispatchCommittedAt", "executionDispatchDueAt", "executionNativeRunId", "executionNativeCallId", "executionNativeSidechainId", "resultEnvelope", "replyContextEnvelope", "replyHandoffActionPluginId", "replyHandoffActionLocalId", "replyHandoffTargetMachineId", "replyHandoffTargetMachineInstallationId", "replyHandoffTargetMaterializationId", "replyHandoffId", "replyHandoffState", "replyHandoffAttempt", "replyHandoffDueAt", "scheduledAt", "dueAt", "claimedAt", "startedAt", "finishedAt", "claimedByMachineId", "leaseExpiresAt", "attempt", "revision", "summaryCiphertext", "errorCode", "errorMessage", "producedSessionId", "createdAt", "updatedAt", "automationScopeCaptured", "automationScopeSessionId", "attentionSeenFailureAt", "managedCreationId", "originDiscussionId", "workflowDisplaySummaryEnvelope", "resultEnvelopeBytes", "workflowCheckpointEnvelopeBytes", "causeActionEvidenceJson", "causePluginEventEvidenceJson") SELECT "id", "originKind", "automationId", "originSessionId", "workflowAcceptedSnapshotEnvelope", "sourceArtifactId", "visibleTeamId", "workflowCheckpointEnvelope", "workflowCustodyState", "workflowResumeRequestedRevision", "originDeliveryAckRevision", "accountId", "state", "triggerId", "causeKind", "causeTriggerKind", "causeTriggerRevision", "causeEventPluginId", "causeEventLocalId", "causeOccurredAt", "causeScheduledFor", "causeSessionLifecycleEvent", "causeSourceSessionId", "causeSourceTurnId", "causeRunLifecycleEvidenceJson", "causeOriginRunId", "causeSessionLifecycleRequestId", "causeSessionLifecycleRequestKind", "causeSessionLifecyclePolicyKind", "causeSessionLifecycleConfiguredCount", "occurrenceKey", "idempotencyKey", "occurrenceEvidenceEqualityTag", "causeSourceSelectorId", "triggerEvidenceEnvelope", "executionInputEnvelope", "executionDispatchState", "executionAttempt", "executionDispatchCommittedAt", "executionDispatchDueAt", "executionNativeRunId", "executionNativeCallId", "executionNativeSidechainId", "resultEnvelope", "replyContextEnvelope", "replyHandoffActionPluginId", "replyHandoffActionLocalId", "replyHandoffTargetMachineId", "replyHandoffTargetMachineInstallationId", "replyHandoffTargetMaterializationId", "replyHandoffId", "replyHandoffState", "replyHandoffAttempt", "replyHandoffDueAt", "scheduledAt", "dueAt", "claimedAt", "startedAt", "finishedAt", "claimedByMachineId", "leaseExpiresAt", "attempt", "revision", "summaryCiphertext", "errorCode", "errorMessage", "producedSessionId", "createdAt", "updatedAt", "automationScopeCaptured", "automationScopeSessionId", "attentionSeenFailureAt", "managedCreationId", "originDiscussionId", "workflowDisplaySummaryEnvelope", "resultEnvelopeBytes", "workflowCheckpointEnvelopeBytes", "causeActionEvidenceJson", "causePluginEventEvidenceJson" FROM "AutomationRun";

DROP TABLE "AutomationRun";

ALTER TABLE "new_AutomationRun" RENAME TO "AutomationRun";

CREATE INDEX "AutomationRun_accountId_causeKind_state_idx" ON "AutomationRun"("accountId", "causeKind", "state");

CREATE INDEX "AutomationRun_accountId_state_dueAt_idx" ON "AutomationRun"("accountId", "state", "dueAt");

CREATE INDEX "AutomationRun_account_created_id_idx" ON "AutomationRun"("accountId", "createdAt" DESC, "id" DESC);

CREATE INDEX "AutomationRun_account_managed_creation_idx" ON "AutomationRun"("accountId", "managedCreationId");

CREATE INDEX "AutomationRun_account_origin_created_id_idx" ON "AutomationRun"("accountId", "originKind", "createdAt" DESC, "id" DESC);

CREATE INDEX "AutomationRun_automationId_createdAt_id_idx" ON "AutomationRun"("automationId", "createdAt" DESC, "id" DESC);

CREATE INDEX "AutomationRun_automationId_dueAt_idx" ON "AutomationRun"("automationId", "dueAt");

CREATE UNIQUE INDEX "AutomationRun_automationId_idempotencyKey_key" ON "AutomationRun"("automationId", "idempotencyKey");

CREATE UNIQUE INDEX "AutomationRun_automationId_occurrenceKey_key" ON "AutomationRun"("automationId", "occurrenceKey");

CREATE INDEX "AutomationRun_claimedByMachineId_leaseExpiresAt_idx" ON "AutomationRun"("claimedByMachineId", "leaseExpiresAt");

CREATE INDEX "AutomationRun_originDiscussion_created_id_idx" ON "AutomationRun"("originDiscussionId", "createdAt" DESC, "id" DESC);

CREATE INDEX "AutomationRun_originSession_created_id_idx" ON "AutomationRun"("originSessionId", "createdAt" DESC, "id" DESC);

CREATE INDEX "AutomationRun_replyHandoffState_replyHandoffDueAt_idx" ON "AutomationRun"("replyHandoffState", "replyHandoffDueAt");

CREATE INDEX "AutomationRun_source_created_id_idx" ON "AutomationRun"("sourceArtifactId", "createdAt" DESC, "id" DESC);

CREATE INDEX "AutomationRun_state_dueAt_idx" ON "AutomationRun"("state", "dueAt");

CREATE INDEX "AutomationRun_state_finishedAt_idx" ON "AutomationRun"("state", "finishedAt");

CREATE INDEX "AutomationRun_triggerId_state_idx" ON "AutomationRun"("triggerId", "state");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
