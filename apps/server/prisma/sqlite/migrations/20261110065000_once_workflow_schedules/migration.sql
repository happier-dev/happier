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
    "scheduledAt" DATETIME,
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
            AND (("scheduleKind" = 'cron' AND "scheduleExpr" IS NOT NULL AND "everyMs" IS NULL AND "scheduledAt" IS NULL)
                OR ("scheduleKind" = 'interval' AND "scheduleExpr" IS NULL AND "everyMs" IS NOT NULL AND "scheduledAt" IS NULL)
                OR ("scheduleKind" = 'once' AND "scheduledAt" IS NOT NULL AND "scheduleExpr" IS NULL AND "everyMs" IS NULL AND "timezone" IS NULL AND "remainingOccurrences" BETWEEN 0 AND 1))
            AND "eventPluginId" IS NULL AND "eventLocalId" IS NULL AND "sourceSelectorId" IS NULL
            AND "sourceContractVersion" IS NULL AND "observationTransport" IS NULL
            AND "webhookEndpointId" IS NULL AND "observationStartsAt" IS NULL
            AND "watcherMachineId" IS NULL AND "watcherMachineInstallationId" IS NULL
            AND "watcherPluginId" IS NULL AND "watcherMaterializationId" IS NULL
            AND "definitionEnvelope" IS NULL
            AND "sessionLifecycleEventsJson" IS NULL AND "sessionLifecyclePolicyKind" IS NULL
            AND "sessionLifecycleMatchCount" IS NULL AND ("scheduleKind" = 'once' OR "remainingOccurrences" IS NULL)
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
SELECT "id", "automationId", "kind", "enabled", "revision", "deletedAt", "scheduleKind", "scheduleExpr", "everyMs", "timezone", "nextRunAt", "eventPluginId", "eventLocalId", "sourceSelectorId", "sourceContractVersion", "observationTransport", "webhookEndpointId", "observationStartsAt", "watcherMachineId", "watcherMachineInstallationId", "watcherPluginId", "watcherMaterializationId", "definitionEnvelope", "sessionLifecycleEventsJson", "sessionLifecyclePolicyKind", "sessionLifecycleMatchCount", "remainingOccurrences", "sourceSessionId", "sourceTurnId", "sourceRunId", "sourceRunMachineId", "runLifecycleConfigurationJson", "createdAt", "updatedAt" FROM "AutomationTrigger";
DROP TABLE "AutomationTrigger";
ALTER TABLE "new_AutomationTrigger" RENAME TO "AutomationTrigger";
CREATE INDEX "AutomationTrigger_automationId_enabled_updatedAt_idx" ON "AutomationTrigger"("automationId", "enabled", "updatedAt");
CREATE INDEX "AutomationTrigger_event_lookup_idx" ON "AutomationTrigger"("enabled", "kind", "eventPluginId", "eventLocalId");
CREATE INDEX "AutomationTrigger_watcher_lookup_idx" ON "AutomationTrigger"("enabled", "watcherMachineId", "watcherMaterializationId");
CREATE INDEX "AutomationTrigger_schedule_due_idx" ON "AutomationTrigger"("kind", "enabled", "deletedAt", "nextRunAt", "id");
CREATE INDEX "AutomationTrigger_session_lifecycle_lookup_idx" ON "AutomationTrigger"("sourceSessionId", "sourceTurnId");
CREATE INDEX "AutomationTrigger_run_lifecycle_lookup_idx" ON "AutomationTrigger"("sourceRunId", "kind", "deletedAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
