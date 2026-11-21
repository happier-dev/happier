ALTER TABLE `PluginWebhookEndpoint` ADD COLUMN `providerRepositoryHookId` VARCHAR(191) NULL;

-- A pending managed endpoint is a reference on an existing pull watcher.
ALTER TABLE `AutomationTrigger` DROP CHECK `AutomationTrigger_arm_check`,
    ADD CONSTRAINT `AutomationTrigger_arm_check` CHECK (
    (((((
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
            AND ((`observationTransport` = 'checkpointedPull'
                    AND (`webhookEndpointId` IS NULL OR `watcherMachineId` IS NOT NULL)
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
            AND `sessionLifecycleEventsJson` IS NOT NULL AND JSON_VALID(`sessionLifecycleEventsJson`)
            AND JSON_TYPE(`sessionLifecycleEventsJson`) = 'ARRAY'
            AND JSON_LENGTH(`sessionLifecycleEventsJson`) > 0
            AND `sessionLifecyclePolicyKind` IS NOT NULL             AND ((`sessionLifecyclePolicyKind` = 'currentTurn' AND `sourceSessionId` IS NOT NULL AND (`subjectKind` IS NULL OR `subjectKind` = 'session')
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
    ) AND `sourceRunId` IS NULL AND `sourceRunMachineId` IS NULL AND `runLifecycleConfigurationJson` IS NULL) OR (`kind` = 'runLifecycle' AND `deletedAt` IS NULL AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL AND `everyMs` IS NULL AND `timezone` IS NULL AND `nextRunAt` IS NULL AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL AND `sourceContractVersion` IS NULL AND `observationTransport` IS NULL AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL AND `definitionEnvelope` IS NULL AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL AND `sessionLifecycleMatchCount` IS NULL AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL AND `sourceRunId` IS NOT NULL AND `runLifecycleConfigurationJson` IS NOT NULL AND `remainingOccurrences` BETWEEN 0 AND 1)) AND `kind` <> 'action' AND `actionId` IS NULL AND `actionIdsJson` IS NULL AND `phase` IS NULL AND `mode` IS NULL AND `onFailure` IS NULL AND `consentForAutomationId` IS NULL AND `consentForTriggerId` IS NULL AND `consentedWorkflowRevision` IS NULL)
        OR (`kind` = 'action' AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL AND `everyMs` IS NULL AND `timezone` IS NULL AND `nextRunAt` IS NULL AND `scheduledAt` IS NULL AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL AND `sourceContractVersion` IS NULL AND `observationTransport` IS NULL AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL AND `sessionLifecycleMatchCount` IS NULL AND `remainingOccurrences` IS NULL AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL AND `sourceRunId` IS NULL AND `sourceRunMachineId` IS NULL AND `runLifecycleConfigurationJson` IS NULL
            AND ((`deletedAt` IS NOT NULL AND `enabled` = false AND `definitionEnvelope` IS NULL AND `subjectKind` IS NULL AND `subjectKey` IS NULL AND `actionId` IS NULL AND `actionIdsJson` IS NULL AND `phase` IS NULL AND `mode` IS NULL AND `onFailure` IS NULL AND `consentForAutomationId` IS NULL AND `consentForTriggerId` IS NULL AND `consentedWorkflowRevision` IS NULL AND `reachesOthers` = false) OR (`deletedAt` IS NULL AND ((`definitionEnvelope` IS NOT NULL AND `actionIdsJson` IS NOT NULL
            AND JSON_VALID(`actionIdsJson`) AND JSON_TYPE(`actionIdsJson`) = 'ARRAY' AND JSON_LENGTH(`actionIdsJson`) > 0
            AND `phase` IS NOT NULL AND `phase` IN ('before', 'after')
            AND (`mode` IS NULL OR `mode` IN ('wait', 'notify'))
            AND (`onFailure` IS NULL OR `onFailure` IN ('refuse', 'ask'))
            AND (`phase` = 'before' OR (`mode` IS NULL AND `onFailure` IS NULL))
            AND (`mode` IS NULL OR `mode` <> 'notify' OR `onFailure` IS NULL)
            AND `consentForAutomationId` IS NULL AND `consentForTriggerId` IS NULL AND `consentedWorkflowRevision` IS NULL) OR (`consentForAutomationId` IS NOT NULL AND `consentForTriggerId` IS NOT NULL
            AND `consentedWorkflowRevision` IS NOT NULL AND `consentedWorkflowRevision` >= 0
            AND `definitionEnvelope` IS NULL AND `subjectKind` IS NULL AND `subjectKey` IS NULL AND `actionId` IS NULL AND `actionIdsJson` IS NULL AND `phase` IS NULL AND `mode` IS NULL AND `onFailure` IS NULL
            AND `reachesOthers` = false))))))
    AND ((`subjectKind` IS NULL AND `subjectKey` IS NULL) OR (`subjectKind` IS NOT NULL AND `subjectKey` IS NOT NULL))
    AND (`deletedAt` IS NULL OR (`subjectKind` IS NULL AND `subjectKey` IS NULL AND `reachesOthers` = false))
);
