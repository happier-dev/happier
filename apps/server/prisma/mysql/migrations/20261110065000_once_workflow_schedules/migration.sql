ALTER TABLE `AutomationTrigger` MODIFY `scheduleKind` ENUM('cron', 'interval', 'manual', 'once') NULL,
    ADD COLUMN `scheduledAt` DATETIME(3) NULL;

ALTER TABLE `AutomationTrigger` DROP CHECK `AutomationTrigger_arm_check`;
ALTER TABLE `AutomationTrigger` ADD CONSTRAINT `AutomationTrigger_arm_check` CHECK (((
        (`deletedAt` IS NOT NULL AND `enabled` = false AND `kind` <> 'pluginEvent' AND `nextRunAt` IS NULL
            AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL AND `everyMs` IS NULL AND `timezone` IS NULL
            AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL
            AND `sourceContractVersion` IS NULL
            AND `definitionEnvelope` IS NULL AND `observationTransport` IS NULL
            AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL
            AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL
            AND `sessionLifecycleMatchCount` IS NULL AND `remainingOccurrences` IS NULL
            AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL)
        OR (`deletedAt` IS NOT NULL AND `enabled` = false AND `kind` = 'pluginEvent'
            AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL AND `everyMs` IS NULL
            AND `timezone` IS NULL AND `nextRunAt` IS NULL
            AND `eventPluginId` IS NOT NULL AND `eventLocalId` IS NOT NULL
            AND `sourceSelectorId` IS NOT NULL AND `sourceContractVersion` IS NOT NULL
            AND `definitionEnvelope` IS NULL AND `observationTransport` IS NULL
            AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL
            AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL
            AND `sessionLifecycleMatchCount` IS NULL AND `remainingOccurrences` IS NULL
            AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL)
        OR (`deletedAt` IS NULL AND `kind` = 'schedule' AND `scheduleKind` IS NOT NULL
            AND ((`scheduleKind` = 'cron' AND `scheduleExpr` IS NOT NULL AND `everyMs` IS NULL AND `scheduledAt` IS NULL)
                OR (`scheduleKind` = 'interval' AND `scheduleExpr` IS NULL AND `everyMs` IS NOT NULL AND `scheduledAt` IS NULL)
                OR (`scheduleKind` = 'once' AND `scheduledAt` IS NOT NULL AND `scheduleExpr` IS NULL AND `everyMs` IS NULL AND `timezone` IS NULL AND `remainingOccurrences` BETWEEN 0 AND 1))
            AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL
            AND `sourceContractVersion` IS NULL AND `observationTransport` IS NULL
            AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL
            AND `definitionEnvelope` IS NULL
            AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL
            AND `sessionLifecycleMatchCount` IS NULL AND (`scheduleKind` = 'once' OR `remainingOccurrences` IS NULL)
            AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL)
        OR (`deletedAt` IS NULL AND `kind` = 'pluginEvent' AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL
            AND `everyMs` IS NULL AND `timezone` IS NULL AND `nextRunAt` IS NULL
            AND `eventPluginId` IS NOT NULL AND `eventLocalId` IS NOT NULL
            AND `sourceSelectorId` IS NOT NULL AND `sourceContractVersion` IS NOT NULL
            AND `observationTransport` IS NOT NULL
            AND `definitionEnvelope` IS NOT NULL
            AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL
            AND `sessionLifecycleMatchCount` IS NULL AND `remainingOccurrences` IS NULL
            AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL
            AND ((`observationTransport` = 'checkpointedPull' AND `webhookEndpointId` IS NULL
                    AND `observationStartsAt` IS NULL
                    AND ((`watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
                            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL)
                        OR (`watcherMachineId` IS NOT NULL AND `watcherMachineInstallationId` IS NOT NULL
                            AND `watcherPluginId` IS NOT NULL AND `watcherMaterializationId` IS NOT NULL)))
                OR (`observationTransport` = 'socket' AND `webhookEndpointId` IS NULL
                    AND `observationStartsAt` IS NULL
                    AND `watcherMachineId` IS NOT NULL AND `watcherMachineInstallationId` IS NOT NULL
                    AND `watcherPluginId` IS NOT NULL AND `watcherMaterializationId` IS NOT NULL)
                OR (`observationTransport` = 'durablePush' AND `webhookEndpointId` IS NOT NULL
                    AND `observationStartsAt` IS NOT NULL AND `watcherMachineId` IS NULL
                    AND `watcherMachineInstallationId` IS NULL AND `watcherPluginId` IS NULL
                    AND `watcherMaterializationId` IS NULL)))
        OR (`deletedAt` IS NULL AND `kind` IN ('prComment', 'ciFailed')
            AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL AND `everyMs` IS NULL
            AND `timezone` IS NULL AND `nextRunAt` IS NULL
            AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL
            AND `sourceContractVersion` IS NULL AND `observationTransport` IS NULL
            AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL
            AND `definitionEnvelope` IS NOT NULL AND `sourceSessionId` IS NOT NULL
            AND `sourceTurnId` IS NULL
            AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL
            AND `sessionLifecycleMatchCount` IS NULL AND `remainingOccurrences` IS NULL)
        OR (`deletedAt` IS NULL AND `kind` = 'sessionLifecycle' AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL
            AND `everyMs` IS NULL AND `timezone` IS NULL AND `nextRunAt` IS NULL
            AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL
            AND `sourceContractVersion` IS NULL AND `observationTransport` IS NULL
            AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL
            AND `definitionEnvelope` IS NULL
            AND `sessionLifecycleEventsJson` IS NOT NULL AND JSON_VALID(`sessionLifecycleEventsJson`)
            AND JSON_TYPE(`sessionLifecycleEventsJson`) = 'ARRAY'
            AND JSON_LENGTH(`sessionLifecycleEventsJson`) > 0
            AND `sessionLifecyclePolicyKind` IS NOT NULL AND `sourceSessionId` IS NOT NULL
            AND ((`sessionLifecyclePolicyKind` = 'currentTurn'
                    AND `sourceTurnId` IS NOT NULL AND `sessionLifecycleMatchCount` IS NULL
                    AND `remainingOccurrences` BETWEEN 0 AND 1)
                OR (`sessionLifecyclePolicyKind` = 'firstMatch'
                    AND `sourceTurnId` IS NULL AND `sessionLifecycleMatchCount` IS NULL
                    AND `remainingOccurrences` BETWEEN 0 AND 1)
                OR (`sessionLifecyclePolicyKind` = 'nextMatches'
                    AND `sourceTurnId` IS NULL AND `sessionLifecycleMatchCount` > 0
                    AND `remainingOccurrences` BETWEEN 0 AND `sessionLifecycleMatchCount`)
                OR (`sessionLifecyclePolicyKind` = 'everyMatch'
                    AND `sourceTurnId` IS NULL AND `sessionLifecycleMatchCount` IS NULL
                    AND `remainingOccurrences` IS NULL)))
    ) AND `sourceRunId` IS NULL AND `sourceRunMachineId` IS NULL AND `runLifecycleConfigurationJson` IS NULL) OR (`kind` = 'runLifecycle' AND `deletedAt` IS NULL AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL AND `everyMs` IS NULL AND `timezone` IS NULL AND `nextRunAt` IS NULL AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL AND `sourceContractVersion` IS NULL AND `observationTransport` IS NULL AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL AND `definitionEnvelope` IS NULL AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL AND `sessionLifecycleMatchCount` IS NULL AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL AND `sourceRunId` IS NOT NULL AND `runLifecycleConfigurationJson` IS NOT NULL AND `remainingOccurrences` BETWEEN 0 AND 1));
