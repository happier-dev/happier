-- Forward-only source-arm expansion. Existing rows, checks, foreign keys and indexes are retained.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_AutomationTrigger" (
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
    "sessionLifecycleEventsJson" TEXT,
    "sessionLifecyclePolicyKind" TEXT,
    "sessionLifecycleMatchCount" INTEGER,
    "remainingOccurrences" INTEGER,
    "sourceSessionId" TEXT,
    "sourceTurnId" TEXT,
    "sourceRunId" TEXT,
    "sourceRunMachineId" TEXT,
    "runLifecycleConfigurationJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutomationTrigger_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationTrigger_arm_check" CHECK (((
        ("deletedAt" IS NOT NULL AND "enabled" = false AND "kind" <> 'pluginEvent' AND "nextRunAt" IS NULL
            AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL AND "everyMs" IS NULL AND "timezone" IS NULL
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL
            AND "definitionEnvelope" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "sessionLifecycleEventsJson" IS NULL AND "sessionLifecyclePolicyKind" IS NULL
            AND "sessionLifecycleMatchCount" IS NULL AND "remainingOccurrences" IS NULL
            AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL)
        OR ("deletedAt" IS NOT NULL AND "enabled" = false AND "kind" = 'pluginEvent'
            AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL AND "everyMs" IS NULL
            AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NOT NULL AND "eventLocalId" IS NOT NULL
            AND "sourceSelectorId" IS NOT NULL AND "sourceContractVersion" IS NOT NULL
            AND "definitionEnvelope" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "sessionLifecycleEventsJson" IS NULL AND "sessionLifecyclePolicyKind" IS NULL
            AND "sessionLifecycleMatchCount" IS NULL AND "remainingOccurrences" IS NULL
            AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL)
        OR ("deletedAt" IS NULL AND "kind" = 'schedule' AND "scheduleKind" IS NOT NULL
            AND (("scheduleKind" = 'cron' AND "scheduleExpr" IS NOT NULL AND "everyMs" IS NULL)
                OR ("scheduleKind" = 'interval' AND "scheduleExpr" IS NULL AND "everyMs" IS NOT NULL))
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "definitionEnvelope" IS NULL
            AND "sessionLifecycleEventsJson" IS NULL AND "sessionLifecyclePolicyKind" IS NULL
            AND "sessionLifecycleMatchCount" IS NULL AND "remainingOccurrences" IS NULL
            AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL)
        OR ("deletedAt" IS NULL AND "kind" = 'pluginEvent' AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL
            AND "everyMs" IS NULL AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NOT NULL AND "eventLocalId" IS NOT NULL
            AND "sourceSelectorId" IS NOT NULL AND "sourceContractVersion" IS NOT NULL
            AND "observationTransport" IS NOT NULL
            AND "definitionEnvelope" IS NOT NULL
            AND "sessionLifecycleEventsJson" IS NULL AND "sessionLifecyclePolicyKind" IS NULL
            AND "sessionLifecycleMatchCount" IS NULL AND "remainingOccurrences" IS NULL
            AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL
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
        OR ("deletedAt" IS NULL AND "kind" IN ('prComment', 'ciFailed')
            AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL AND "everyMs" IS NULL
            AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "definitionEnvelope" IS NOT NULL AND "sourceSessionId" IS NOT NULL
            AND "sourceTurnId" IS NULL
            AND "sessionLifecycleEventsJson" IS NULL AND "sessionLifecyclePolicyKind" IS NULL
            AND "sessionLifecycleMatchCount" IS NULL AND "remainingOccurrences" IS NULL)
        OR ("deletedAt" IS NULL AND "kind" = 'sessionLifecycle' AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL
            AND "everyMs" IS NULL AND "timezone" IS NULL AND "nextRunAt" IS NULL
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "definitionEnvelope" IS NULL
            AND "sessionLifecycleEventsJson" IS NOT NULL
            AND json_valid("sessionLifecycleEventsJson")
            AND json_type("sessionLifecycleEventsJson") = 'array'
            AND json_array_length("sessionLifecycleEventsJson") > 0
            AND "sessionLifecyclePolicyKind" IN ('currentTurn', 'firstMatch', 'nextMatches', 'everyMatch')
            AND "sourceSessionId" IS NOT NULL
            AND (("sessionLifecyclePolicyKind" = 'currentTurn'
                    AND "sourceTurnId" IS NOT NULL AND "sessionLifecycleMatchCount" IS NULL
                    AND "remainingOccurrences" BETWEEN 0 AND 1)
                OR ("sessionLifecyclePolicyKind" = 'firstMatch'
                    AND "sourceTurnId" IS NULL AND "sessionLifecycleMatchCount" IS NULL
                    AND "remainingOccurrences" BETWEEN 0 AND 1)
                OR ("sessionLifecyclePolicyKind" = 'nextMatches'
                    AND "sourceTurnId" IS NULL AND "sessionLifecycleMatchCount" > 0
                    AND "remainingOccurrences" BETWEEN 0 AND "sessionLifecycleMatchCount")
                OR ("sessionLifecyclePolicyKind" = 'everyMatch'
                    AND "sourceTurnId" IS NULL AND "sessionLifecycleMatchCount" IS NULL
                    AND "remainingOccurrences" IS NULL)))
    ) AND "sourceRunId" IS NULL AND "sourceRunMachineId" IS NULL AND "runLifecycleConfigurationJson" IS NULL) OR ("kind" = 'runLifecycle' AND "deletedAt" IS NULL AND "scheduleKind" IS NULL AND "scheduleExpr" IS NULL AND "everyMs" IS NULL AND "timezone" IS NULL AND "nextRunAt" IS NULL AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL AND "definitionEnvelope" IS NULL AND "sessionLifecycleEventsJson" IS NULL AND "sessionLifecyclePolicyKind" IS NULL AND "sessionLifecycleMatchCount" IS NULL AND "sourceSessionId" IS NULL AND "sourceTurnId" IS NULL AND "sourceRunId" IS NOT NULL AND "runLifecycleConfigurationJson" IS NOT NULL AND "remainingOccurrences" BETWEEN 0 AND 1))
);
INSERT INTO "new_AutomationTrigger" ("id", "automationId", "kind", "enabled", "revision", "deletedAt", "scheduleKind", "scheduleExpr", "everyMs", "timezone", "nextRunAt", "eventPluginId", "eventLocalId", "sourceSelectorId", "sourceContractVersion", "observationTransport", "webhookEndpointId", "observationStartsAt", "watcherMachineId", "watcherMachineInstallationId", "watcherPluginId", "watcherMaterializationId", "definitionEnvelope", "sessionLifecycleEventsJson", "sessionLifecyclePolicyKind", "sessionLifecycleMatchCount", "remainingOccurrences", "sourceSessionId", "sourceTurnId", "sourceRunId", "sourceRunMachineId", "runLifecycleConfigurationJson", "createdAt", "updatedAt")
SELECT "id", "automationId", "kind", "enabled", "revision", "deletedAt", "scheduleKind", "scheduleExpr", "everyMs", "timezone", "nextRunAt", "eventPluginId", "eventLocalId", "sourceSelectorId", "sourceContractVersion", "observationTransport", "webhookEndpointId", "observationStartsAt", "watcherMachineId", "watcherMachineInstallationId", "watcherPluginId", "watcherMaterializationId", "definitionEnvelope", "sessionLifecycleEventsJson", "sessionLifecyclePolicyKind", "sessionLifecycleMatchCount", "remainingOccurrences", "sourceSessionId", "sourceTurnId", NULL, NULL, NULL, "createdAt", "updatedAt" FROM "AutomationTrigger";
DROP TABLE "AutomationTrigger";
ALTER TABLE "new_AutomationTrigger" RENAME TO "AutomationTrigger";
CREATE INDEX "AutomationTrigger_automationId_enabled_updatedAt_idx" ON "AutomationTrigger"("automationId", "enabled", "updatedAt");
CREATE INDEX "AutomationTrigger_event_lookup_idx" ON "AutomationTrigger"("enabled", "kind", "eventPluginId", "eventLocalId");
CREATE INDEX "AutomationTrigger_watcher_lookup_idx" ON "AutomationTrigger"("enabled", "watcherMachineId", "watcherMaterializationId");
CREATE INDEX "AutomationTrigger_schedule_due_idx" ON "AutomationTrigger"("kind", "enabled", "deletedAt", "nextRunAt", "id");
CREATE INDEX "AutomationTrigger_session_lifecycle_lookup_idx" ON "AutomationTrigger"("sourceSessionId", "sourceTurnId");
CREATE INDEX "AutomationTrigger_run_lifecycle_lookup_idx" ON "AutomationTrigger"("sourceRunId", "kind", "deletedAt");

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
    "updatedAt" DATETIME NOT NULL,
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
    CONSTRAINT "AutomationRun_cause_arm_check" CHECK ((("originKind" = 'direct' OR (
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
                    AND "causeSessionLifecycleEvent" IN ('parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled', 'userActionRequired', 'sessionStarted', 'sessionArchived')
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
    )) AND "causeRunLifecycleEvidenceJson" IS NULL) OR ("originKind" = 'automation' AND "causeKind" = 'trigger' AND "causeTriggerKind" = 'runLifecycle' AND "triggerId" IS NOT NULL AND "causeTriggerRevision" IS NOT NULL AND "causeOccurredAt" IS NOT NULL AND "occurrenceKey" IS NOT NULL AND "causeRunLifecycleEvidenceJson" IS NOT NULL AND "causeEventPluginId" IS NULL AND "causeEventLocalId" IS NULL AND "causeScheduledFor" IS NULL AND "causeSessionLifecycleEvent" IS NULL AND "causeSourceSessionId" IS NULL AND "causeSourceTurnId" IS NULL AND "causeSessionLifecycleRequestId" IS NULL AND "causeSessionLifecycleRequestKind" IS NULL AND "causeSessionLifecyclePolicyKind" IS NULL AND "causeSessionLifecycleConfiguredCount" IS NULL AND "causeSourceSelectorId" IS NULL AND "triggerEvidenceEnvelope" IS NULL AND "occurrenceEvidenceEqualityTag" IS NULL AND "idempotencyKey" IS NULL)),
    CONSTRAINT "AutomationRun_execution_input_arm_check" CHECK (
        "state" NOT IN ('queued', 'claimed', 'running')
        OR "executionInputEnvelope" IS NOT NULL
        OR "workflowAcceptedSnapshotEnvelope" IS NOT NULL
    ),
    CONSTRAINT "AutomationRun_reply_handoff_arm_check" CHECK ("originKind" = 'direct' OR (
        ("causeKind" = 'conversation' AND "replyContextEnvelope" IS NOT NULL AND "replyHandoffActionPluginId" IS NOT NULL AND "replyHandoffActionLocalId" IS NOT NULL AND "replyHandoffTargetMachineId" IS NOT NULL AND "replyHandoffTargetMachineInstallationId" IS NOT NULL AND "replyHandoffTargetMaterializationId" IS NOT NULL AND "replyHandoffId" IS NOT NULL AND "replyHandoffState" <> 'none')
        OR ("causeKind" IN ('trigger', 'manual', 'conversation') AND "replyContextEnvelope" IS NULL AND "replyHandoffActionPluginId" IS NULL AND "replyHandoffActionLocalId" IS NULL AND "replyHandoffTargetMachineId" IS NULL AND "replyHandoffTargetMachineInstallationId" IS NULL AND "replyHandoffTargetMaterializationId" IS NULL AND "replyHandoffId" IS NULL AND "replyHandoffState" = 'none' AND "replyHandoffAttempt" = 0 AND "replyHandoffDueAt" IS NULL)
    ))
);
INSERT INTO "new_AutomationRun" ("id", "originKind", "automationId", "originSessionId", "workflowAcceptedSnapshotEnvelope", "sourceArtifactId", "visibleTeamId", "workflowCheckpointEnvelope", "workflowCustodyState", "workflowResumeRequestedRevision", "originDeliveryAckRevision", "accountId", "state", "triggerId", "causeKind", "causeTriggerKind", "causeTriggerRevision", "causeEventPluginId", "causeEventLocalId", "causeOccurredAt", "causeScheduledFor", "causeSessionLifecycleEvent", "causeSourceSessionId", "causeSourceTurnId", "causeRunLifecycleEvidenceJson", "causeSessionLifecycleRequestId", "causeSessionLifecycleRequestKind", "causeSessionLifecyclePolicyKind", "causeSessionLifecycleConfiguredCount", "occurrenceKey", "idempotencyKey", "occurrenceEvidenceEqualityTag", "causeSourceSelectorId", "triggerEvidenceEnvelope", "executionInputEnvelope", "executionDispatchState", "executionAttempt", "executionDispatchCommittedAt", "executionDispatchDueAt", "executionNativeRunId", "executionNativeCallId", "executionNativeSidechainId", "resultEnvelope", "replyContextEnvelope", "replyHandoffActionPluginId", "replyHandoffActionLocalId", "replyHandoffTargetMachineId", "replyHandoffTargetMachineInstallationId", "replyHandoffTargetMaterializationId", "replyHandoffId", "replyHandoffState", "replyHandoffAttempt", "replyHandoffDueAt", "scheduledAt", "dueAt", "claimedAt", "startedAt", "finishedAt", "claimedByMachineId", "leaseExpiresAt", "attempt", "revision", "summaryCiphertext", "errorCode", "errorMessage", "producedSessionId", "createdAt", "updatedAt")
SELECT "id", "originKind", "automationId", "originSessionId", "workflowAcceptedSnapshotEnvelope", "sourceArtifactId", "visibleTeamId", "workflowCheckpointEnvelope", "workflowCustodyState", "workflowResumeRequestedRevision", "originDeliveryAckRevision", "accountId", "state", "triggerId", "causeKind", "causeTriggerKind", "causeTriggerRevision", "causeEventPluginId", "causeEventLocalId", "causeOccurredAt", "causeScheduledFor", "causeSessionLifecycleEvent", "causeSourceSessionId", "causeSourceTurnId", NULL, "causeSessionLifecycleRequestId", "causeSessionLifecycleRequestKind", "causeSessionLifecyclePolicyKind", "causeSessionLifecycleConfiguredCount", "occurrenceKey", "idempotencyKey", "occurrenceEvidenceEqualityTag", "causeSourceSelectorId", "triggerEvidenceEnvelope", "executionInputEnvelope", "executionDispatchState", "executionAttempt", "executionDispatchCommittedAt", "executionDispatchDueAt", "executionNativeRunId", "executionNativeCallId", "executionNativeSidechainId", "resultEnvelope", "replyContextEnvelope", "replyHandoffActionPluginId", "replyHandoffActionLocalId", "replyHandoffTargetMachineId", "replyHandoffTargetMachineInstallationId", "replyHandoffTargetMaterializationId", "replyHandoffId", "replyHandoffState", "replyHandoffAttempt", "replyHandoffDueAt", "scheduledAt", "dueAt", "claimedAt", "startedAt", "finishedAt", "claimedByMachineId", "leaseExpiresAt", "attempt", "revision", "summaryCiphertext", "errorCode", "errorMessage", "producedSessionId", "createdAt", "updatedAt" FROM "AutomationRun";
DROP TABLE "AutomationRun";
ALTER TABLE "new_AutomationRun" RENAME TO "AutomationRun";
CREATE INDEX "AutomationRun_accountId_state_dueAt_idx" ON "AutomationRun"("accountId", "state", "dueAt");
CREATE INDEX "AutomationRun_accountId_causeKind_state_idx" ON "AutomationRun"("accountId", "causeKind", "state");
CREATE INDEX "AutomationRun_automationId_dueAt_idx" ON "AutomationRun"("automationId", "dueAt");
CREATE INDEX "AutomationRun_automationId_createdAt_id_idx" ON "AutomationRun"("automationId", "createdAt" DESC, "id" DESC);
CREATE INDEX "AutomationRun_claimedByMachineId_leaseExpiresAt_idx" ON "AutomationRun"("claimedByMachineId", "leaseExpiresAt");
CREATE INDEX "AutomationRun_state_finishedAt_idx" ON "AutomationRun"("state", "finishedAt");
CREATE INDEX "AutomationRun_state_dueAt_idx" ON "AutomationRun"("state", "dueAt");
CREATE INDEX "AutomationRun_replyHandoffState_replyHandoffDueAt_idx" ON "AutomationRun"("replyHandoffState", "replyHandoffDueAt");
CREATE INDEX "AutomationRun_triggerId_state_idx" ON "AutomationRun"("triggerId", "state");
CREATE INDEX "AutomationRun_account_origin_created_id_idx" ON "AutomationRun"("accountId", "originKind", "createdAt" DESC, "id" DESC);
CREATE INDEX "AutomationRun_account_created_id_idx" ON "AutomationRun"("accountId", "createdAt" DESC, "id" DESC);
CREATE INDEX "AutomationRun_source_created_id_idx" ON "AutomationRun"("sourceArtifactId", "createdAt" DESC, "id" DESC);
CREATE INDEX "AutomationRun_originSession_created_id_idx" ON "AutomationRun"("originSessionId", "createdAt" DESC, "id" DESC);
CREATE UNIQUE INDEX "AutomationRun_automationId_occurrenceKey_key" ON "AutomationRun"("automationId", "occurrenceKey");
CREATE UNIQUE INDEX "AutomationRun_automationId_idempotencyKey_key" ON "AutomationRun"("automationId", "idempotencyKey");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
