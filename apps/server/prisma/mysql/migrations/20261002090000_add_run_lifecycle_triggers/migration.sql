ALTER TABLE `AutomationTrigger` MODIFY COLUMN `kind` ENUM('schedule', 'pluginEvent', 'sessionLifecycle', 'runLifecycle', 'prComment', 'ciFailed') NOT NULL,
  ADD COLUMN `sourceRunId` VARCHAR(191) NULL, ADD COLUMN `sourceRunMachineId` VARCHAR(191) NULL,
  ADD COLUMN `runLifecycleConfigurationJson` LONGTEXT NULL;
CREATE INDEX `AutomationTrigger_run_lifecycle_lookup_idx` ON `AutomationTrigger`(`sourceRunId`, `kind`, `deletedAt`);
ALTER TABLE `AutomationRun` MODIFY COLUMN `causeTriggerKind` ENUM('schedule', 'pluginEvent', 'sessionLifecycle', 'runLifecycle', 'prComment', 'ciFailed') NULL,
  ADD COLUMN `causeRunLifecycleEvidenceJson` LONGTEXT NULL;
ALTER TABLE `AutomationRun` ADD COLUMN `causeOriginRunId` VARCHAR(191) NULL;
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_archive_origin_arm_check` CHECK (
  `causeOriginRunId` IS NULL OR (
    `originKind` = 'automation' AND `causeKind` IS NOT NULL AND `causeKind` = 'trigger'
    AND `causeTriggerKind` IS NOT NULL AND `causeTriggerKind` = 'sessionLifecycle'
    AND `causeSessionLifecycleEvent` IS NOT NULL AND `causeSessionLifecycleEvent` = 'sessionArchived'
  )
);

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
            AND ((`scheduleKind` = 'cron' AND `scheduleExpr` IS NOT NULL AND `everyMs` IS NULL)
                OR (`scheduleKind` = 'interval' AND `scheduleExpr` IS NULL AND `everyMs` IS NOT NULL))
            AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL
            AND `sourceContractVersion` IS NULL AND `observationTransport` IS NULL
            AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL
            AND `definitionEnvelope` IS NULL
            AND `sessionLifecycleEventsJson` IS NULL AND `sessionLifecyclePolicyKind` IS NULL
            AND `sessionLifecycleMatchCount` IS NULL AND `remainingOccurrences` IS NULL
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

ALTER TABLE `AutomationRun` DROP CHECK `AutomationRun_cause_arm_check`;
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_cause_arm_check` CHECK (((
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
) AND `causeRunLifecycleEvidenceJson` IS NULL) OR (`originKind` = 'automation' AND `causeKind` = 'trigger' AND `causeTriggerKind` = 'runLifecycle' AND `triggerId` IS NOT NULL AND `causeTriggerRevision` IS NOT NULL AND `causeOccurredAt` IS NOT NULL AND `occurrenceKey` IS NOT NULL AND `causeRunLifecycleEvidenceJson` IS NOT NULL AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL AND `causeScheduledFor` IS NULL AND `causeSessionLifecycleEvent` IS NULL AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL AND `causeSessionLifecycleRequestId` IS NULL AND `causeSessionLifecycleRequestKind` IS NULL AND `causeSessionLifecyclePolicyKind` IS NULL AND `causeSessionLifecycleConfiguredCount` IS NULL AND `causeSourceSelectorId` IS NULL AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL AND `idempotencyKey` IS NULL));
