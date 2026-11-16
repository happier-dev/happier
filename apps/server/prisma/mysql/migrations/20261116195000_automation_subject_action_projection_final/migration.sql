ALTER TABLE `AutomationTrigger` MODIFY COLUMN `kind` ENUM('schedule', 'pluginEvent', 'sessionLifecycle', 'runLifecycle', 'prComment', 'ciFailed', 'action') NOT NULL;

ALTER TABLE `AutomationRun` MODIFY COLUMN `causeTriggerKind` ENUM('schedule', 'pluginEvent', 'sessionLifecycle', 'runLifecycle', 'prComment', 'ciFailed', 'action') NULL;

ALTER TABLE `AutomationTrigger`
    ADD COLUMN `subjectKind` VARCHAR(191) NULL,
    ADD COLUMN `subjectKey` VARCHAR(191) NULL,
    ADD COLUMN `reachesOthers` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `actionId` LONGTEXT NULL,
    ADD COLUMN `actionIdsJson` LONGTEXT NULL,
    ADD COLUMN `phase` VARCHAR(191) NULL,
    ADD COLUMN `mode` VARCHAR(191) NULL,
    ADD COLUMN `onFailure` VARCHAR(191) NULL,
    ADD COLUMN `consentForAutomationId` VARCHAR(191) NULL,
    ADD COLUMN `consentForTriggerId` VARCHAR(191) NULL,
    ADD COLUMN `consentedWorkflowRevision` INTEGER NULL;

ALTER TABLE `AutomationRun` ADD COLUMN `causeActionEvidenceJson` LONGTEXT NULL, ADD COLUMN `causePluginEventEvidenceJson` LONGTEXT NULL;

ALTER TABLE `AutomationTrigger` DROP CHECK `AutomationTrigger_arm_check`;

ALTER TABLE `AutomationTrigger` ADD CONSTRAINT `AutomationTrigger_arm_check` CHECK (
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

ALTER TABLE `AutomationRun` DROP CHECK `AutomationRun_cause_arm_check`;

ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_cause_arm_check` CHECK (((((
    `originKind` = 'direct' OR (
        (`causeKind` = 'trigger' AND `idempotencyKey` IS NULL AND `causeTriggerKind` IS NOT NULL
            AND `triggerId` IS NOT NULL AND `causeTriggerRevision` IS NOT NULL
            AND `causeOccurredAt` IS NOT NULL AND `occurrenceKey` IS NOT NULL AND (
                (`causeTriggerKind` = 'schedule' AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL
                    AND `causeScheduledFor` IS NOT NULL
                    AND `causeSessionLifecycleEvent` IS NULL AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL
                    AND `causeSessionLifecycleRequestId` IS NULL AND `causeSessionLifecycleRequestKind` IS NULL
                    AND `causeSessionLifecyclePolicyKind` IS NULL AND `causeSessionLifecycleConfiguredCount` IS NULL
                    AND `causeSourceSelectorId` IS NULL AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL)
                OR (`causeTriggerKind` = 'pluginEvent' AND `causeEventPluginId` IS NOT NULL AND `causeEventLocalId` IS NOT NULL
                    AND `causeScheduledFor` IS NULL
                    AND `causeSessionLifecycleEvent` IS NULL AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL
                    AND `causeSessionLifecycleRequestId` IS NULL AND `causeSessionLifecycleRequestKind` IS NULL
                    AND `causeSessionLifecyclePolicyKind` IS NULL AND `causeSessionLifecycleConfiguredCount` IS NULL
                    AND `causeSourceSelectorId` IS NOT NULL AND `triggerEvidenceEnvelope` IS NOT NULL
                    AND ((COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
                                CASE WHEN JSON_VALID(`triggerEvidenceEnvelope`) THEN `triggerEvidenceEnvelope` ELSE NULL END,
                                '$.t'
                            )) = 'plain', FALSE) AND `occurrenceEvidenceEqualityTag` IS NULL)
                        OR (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
                                CASE WHEN JSON_VALID(`triggerEvidenceEnvelope`) THEN `triggerEvidenceEnvelope` ELSE NULL END,
                                '$.t'
                            )) = 'encrypted', FALSE)
                            AND `occurrenceEvidenceEqualityTag` IS NOT NULL
                            AND CHAR_LENGTH(`occurrenceEvidenceEqualityTag`) = 43
                            AND `occurrenceEvidenceEqualityTag` REGEXP '^[A-Za-z0-9_-]{43}$')))
                OR (`causeTriggerKind` = 'sessionLifecycle' AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL
                    AND `causeScheduledFor` IS NULL
                    AND `causeSessionLifecycleEvent` IS NOT NULL AND `causeSourceSessionId` IS NOT NULL
                    AND ((`causeSessionLifecycleEvent` IN ('sessionStarted', 'sessionArchived') AND `causeSourceTurnId` IS NULL)
                        OR (`causeSessionLifecycleEvent` NOT IN ('sessionStarted', 'sessionArchived') AND `causeSourceTurnId` IS NOT NULL))
                    AND `causeSourceSelectorId` IS NULL
                    AND `causeSessionLifecyclePolicyKind` IS NOT NULL
                    AND ((`causeSessionLifecycleEvent` = 'userActionRequired'
                            AND `causeSessionLifecycleRequestId` IS NOT NULL
                            AND `causeSessionLifecycleRequestKind` IS NOT NULL)
                        OR (`causeSessionLifecycleEvent` <> 'userActionRequired'
                            AND `causeSessionLifecycleRequestId` IS NULL
                            AND `causeSessionLifecycleRequestKind` IS NULL))
                    AND ((`causeSessionLifecyclePolicyKind` = 'nextMatches'
                            AND `causeSessionLifecycleConfiguredCount` > 0)
                        OR (`causeSessionLifecyclePolicyKind` <> 'nextMatches'
                            AND `causeSessionLifecycleConfiguredCount` IS NULL))
                    AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL)
            ))
        OR (`causeKind` = 'manual' AND `triggerId` IS NULL AND `causeTriggerKind` IS NULL
            AND `causeTriggerRevision` IS NULL AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL
            AND `causeOccurredAt` IS NOT NULL AND `causeScheduledFor` IS NULL AND `causeSessionLifecycleEvent` IS NULL
            AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL
            AND `causeSessionLifecycleRequestId` IS NULL AND `causeSessionLifecycleRequestKind` IS NULL
            AND `causeSessionLifecyclePolicyKind` IS NULL AND `causeSessionLifecycleConfiguredCount` IS NULL
            AND (`occurrenceKey` IS NULL OR `idempotencyKey` IS NULL)
            AND `causeSourceSelectorId` IS NULL
            AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL)
        OR (`causeKind` = 'conversation' AND `idempotencyKey` IS NULL
            AND `causeTriggerKind` IS NULL
            AND `causeTriggerRevision` IS NULL AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL
            AND `causeOccurredAt` IS NOT NULL AND `causeScheduledFor` IS NULL AND `causeSessionLifecycleEvent` IS NULL
            AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL
            AND `causeSessionLifecycleRequestId` IS NULL AND `causeSessionLifecycleRequestKind` IS NULL
            AND `causeSessionLifecyclePolicyKind` IS NULL AND `causeSessionLifecycleConfiguredCount` IS NULL
            AND `occurrenceKey` IS NOT NULL AND `causeSourceSelectorId` IS NULL
            AND `triggerEvidenceEnvelope` IS NOT NULL
            AND ((COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
                        CASE WHEN JSON_VALID(`triggerEvidenceEnvelope`) THEN `triggerEvidenceEnvelope` ELSE NULL END,
                        '$.t'
                    )) = 'plain', FALSE) AND `occurrenceEvidenceEqualityTag` IS NULL)
                OR (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
                        CASE WHEN JSON_VALID(`triggerEvidenceEnvelope`) THEN `triggerEvidenceEnvelope` ELSE NULL END,
                        '$.t'
                    )) = 'encrypted', FALSE)
                    AND `occurrenceEvidenceEqualityTag` IS NOT NULL
                    AND CHAR_LENGTH(`occurrenceEvidenceEqualityTag`) = 43
                    AND `occurrenceEvidenceEqualityTag` REGEXP '^[A-Za-z0-9_-]{43}$')))
    )
) AND `causeRunLifecycleEvidenceJson` IS NULL) OR (`originKind` = 'automation' AND `causeKind` = 'trigger' AND `causeTriggerKind` = 'runLifecycle' AND `triggerId` IS NOT NULL AND `causeTriggerRevision` IS NOT NULL AND `causeOccurredAt` IS NOT NULL AND `occurrenceKey` IS NOT NULL AND `causeRunLifecycleEvidenceJson` IS NOT NULL AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL AND `causeScheduledFor` IS NULL AND `causeSessionLifecycleEvent` IS NULL AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL AND `causeSessionLifecycleRequestId` IS NULL AND `causeSessionLifecycleRequestKind` IS NULL AND `causeSessionLifecyclePolicyKind` IS NULL AND `causeSessionLifecycleConfiguredCount` IS NULL AND `causeSourceSelectorId` IS NULL AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL AND `idempotencyKey` IS NULL)) AND `causeActionEvidenceJson` IS NULL AND `causePluginEventEvidenceJson` IS NULL) OR ((`originKind` = 'automation' AND `causeKind` = 'trigger'
        AND `causeTriggerKind` IS NOT NULL AND `causeTriggerKind` = 'action' AND `triggerId` IS NOT NULL
        AND `causeTriggerRevision` IS NOT NULL AND `causeOccurredAt` IS NOT NULL
        AND `occurrenceKey` IS NOT NULL AND `causeActionEvidenceJson` IS NOT NULL
        AND JSON_VALID(`causeActionEvidenceJson`) AND JSON_TYPE(`causeActionEvidenceJson`) = 'OBJECT'
        AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL AND `causeScheduledFor` IS NULL AND `causeSessionLifecycleEvent` IS NULL AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL AND `causeSessionLifecycleRequestId` IS NULL AND `causeSessionLifecycleRequestKind` IS NULL AND `causeSessionLifecyclePolicyKind` IS NULL AND `causeSessionLifecycleConfiguredCount` IS NULL AND `causeSourceSelectorId` IS NULL AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL AND `causeRunLifecycleEvidenceJson` IS NULL AND `causeOriginRunId` IS NULL AND `idempotencyKey` IS NULL) AND `causePluginEventEvidenceJson` IS NULL) OR (`originKind` = 'automation' AND `causeKind` = 'trigger'
        AND `causeTriggerKind` IS NOT NULL AND `causeTriggerKind` = 'pluginEvent' AND `triggerId` IS NOT NULL
        AND `causeTriggerRevision` IS NOT NULL AND `causeOccurredAt` IS NOT NULL
        AND `occurrenceKey` IS NOT NULL AND `causePluginEventEvidenceJson` IS NOT NULL
        AND JSON_VALID(`causePluginEventEvidenceJson`) AND JSON_TYPE(`causePluginEventEvidenceJson`) = 'OBJECT'
        AND `causeEventPluginId` IS NOT NULL AND `causeEventPluginId` = 'happier.machine.services'
        AND `causeEventLocalId` IS NOT NULL AND `causeEventLocalId` IN ('machine-offline', 'machine-online')
        AND `causeSourceSelectorId` IS NOT NULL
        AND `causeScheduledFor` IS NULL AND `causeSessionLifecycleEvent` IS NULL AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL AND `causeSessionLifecycleRequestId` IS NULL AND `causeSessionLifecycleRequestKind` IS NULL AND `causeSessionLifecyclePolicyKind` IS NULL AND `causeSessionLifecycleConfiguredCount` IS NULL AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL AND `causeRunLifecycleEvidenceJson` IS NULL AND `causeOriginRunId` IS NULL AND `idempotencyKey` IS NULL
        AND `causeActionEvidenceJson` IS NULL));

CREATE INDEX `AutomationTrigger_subject_lookup_idx` ON `AutomationTrigger`(`subjectKind`, `subjectKey`, `deletedAt`, `id`);
CREATE INDEX `AutomationTrigger_consent_lookup_idx` ON `AutomationTrigger`(`consentForAutomationId`, `consentForTriggerId`, `deletedAt`, `id`);
