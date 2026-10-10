-- Pre-effect V2 queued/claimed Runs acquire their first frozen input at claim.
-- Effectful open history cannot safely be reconstructed or replayed.
CREATE TEMPORARY TABLE `_AutomationRun_open_frozen_input_preflight` (
    `ok` TINYINT NOT NULL PRIMARY KEY
);
INSERT INTO `_AutomationRun_open_frozen_input_preflight` (`ok`)
SELECT 1
UNION ALL
SELECT 1 FROM DUAL WHERE EXISTS (
    SELECT 1 FROM `AutomationRun` WHERE `state` IN ('queued', 'claimed', 'running') AND (
        `state` = 'running' OR `startedAt` IS NOT NULL OR `finishedAt` IS NOT NULL
        OR `producedSessionId` IS NOT NULL OR `summaryCiphertext` IS NOT NULL
        OR EXISTS (SELECT 1 FROM `AutomationRunEvent` event
            WHERE event.`runId` = `AutomationRun`.`id` AND event.`type` = 'run_started')
    )
);
DROP TEMPORARY TABLE `_AutomationRun_open_frozen_input_preflight`;

ALTER TABLE `Automation`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    MODIFY `targetType` ENUM('new_session', 'existing_session', 'execution_run') NOT NULL;

ALTER TABLE `AutomationRun`
    MODIFY `state` ENUM('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'dispatch_failed', 'skipped', 'missed', 'outcome_uncertain') NOT NULL DEFAULT 'queued',
    ADD COLUMN `triggerId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    ADD COLUMN `causeKind` ENUM('trigger', 'manual', 'conversation') NOT NULL DEFAULT 'trigger',
    ADD COLUMN `causeTriggerKind` ENUM('schedule', 'pluginEvent', 'sessionLifecycle') NULL,
    ADD COLUMN `causeTriggerRevision` INTEGER NULL,
    ADD COLUMN `causeEventPluginId` VARCHAR(191) NULL,
    ADD COLUMN `causeEventLocalId` VARCHAR(191) NULL,
    ADD COLUMN `causeOccurredAt` DATETIME(3) NULL,
    ADD COLUMN `causeScheduledFor` DATETIME(3) NULL,
    ADD COLUMN `causeSessionLifecycleEvent` ENUM('parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled', 'userActionRequired', 'sessionStarted', 'sessionArchived') NULL,
    ADD COLUMN `causeSourceSessionId` VARCHAR(191) NULL,
    ADD COLUMN `causeSourceTurnId` VARCHAR(191) NULL,
    ADD COLUMN `causeSessionLifecycleRequestId` VARCHAR(191) NULL,
    ADD COLUMN `causeSessionLifecycleRequestKind` ENUM('permission', 'user_action') NULL,
    ADD COLUMN `causeSessionLifecyclePolicyKind` ENUM('currentTurn', 'firstMatch', 'nextMatches', 'everyMatch') NULL,
    ADD COLUMN `causeSessionLifecycleConfiguredCount` INTEGER NULL,
    ADD COLUMN `occurrenceKey` CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN `occurrenceEvidenceEqualityTag` VARCHAR(191) NULL,
    ADD COLUMN `causeSourceSelectorId` VARCHAR(191) NULL,
    ADD COLUMN `triggerEvidenceEnvelope` LONGTEXT NULL,
    ADD COLUMN `executionInputEnvelope` LONGTEXT NULL,
    ADD COLUMN `executionDispatchState` ENUM('notStarted', 'dispatchPermitted', 'retryWaiting', 'started', 'settled', 'outcomeUnknown') NULL,
    ADD COLUMN `executionAttempt` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `executionDispatchCommittedAt` DATETIME(3) NULL,
    ADD COLUMN `executionDispatchDueAt` DATETIME(3) NULL,
    ADD COLUMN `executionNativeRunId` VARCHAR(191) NULL,
    ADD COLUMN `executionNativeCallId` VARCHAR(191) NULL,
    ADD COLUMN `executionNativeSidechainId` VARCHAR(191) NULL,
    ADD COLUMN `resultEnvelope` LONGTEXT NULL,
    ADD COLUMN `replyContextEnvelope` LONGTEXT NULL,
    ADD COLUMN `replyHandoffActionPluginId` VARCHAR(191) NULL,
    ADD COLUMN `replyHandoffActionLocalId` VARCHAR(191) NULL,
    ADD COLUMN `replyHandoffTargetMachineId` VARCHAR(191) NULL,
    ADD COLUMN `replyHandoffTargetMachineInstallationId` VARCHAR(191) NULL,
    ADD COLUMN `replyHandoffTargetMaterializationId` VARCHAR(191) NULL,
    ADD COLUMN `replyHandoffId` VARCHAR(191) NULL,
    ADD COLUMN `replyHandoffState` ENUM('none', 'awaitingResult', 'ready', 'handingOff', 'accepted', 'suppressed', 'blocked') NOT NULL DEFAULT 'none',
    ADD COLUMN `replyHandoffAttempt` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `replyHandoffDueAt` DATETIME(3) NULL,
    ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `AutomationTrigger` (
    `id` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `automationId` VARCHAR(191) NOT NULL,
    `kind` ENUM('schedule', 'pluginEvent', 'sessionLifecycle') NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `deletedAt` DATETIME(3) NULL,
    `scheduleKind` ENUM('cron', 'interval') NULL,
    `scheduleExpr` TEXT NULL,
    `everyMs` INTEGER NULL,
    `timezone` VARCHAR(191) NULL,
    `nextRunAt` DATETIME(3) NULL,
    -- Qualified plugin Event identity is author-controlled and compared with
    -- SQL equality (stored-definition listing and event lookups). Exact
    -- collation keeps distinct author IDs distinct; IDs are never normalized.
    `eventPluginId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `eventLocalId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    `sourceSelectorId` VARCHAR(191) NULL,
    `sourceContractVersion` INTEGER NULL,
    `observationTransport` ENUM('checkpointedPull', 'durablePush', 'socket') NULL,
    `webhookEndpointId` VARCHAR(191) NULL,
    `observationStartsAt` DATETIME(3) NULL,
    `watcherMachineId` VARCHAR(191) NULL,
    `watcherMachineInstallationId` VARCHAR(191) NULL,
    `watcherPluginId` VARCHAR(191) NULL,
    `watcherMaterializationId` VARCHAR(191) NULL,
    `definitionEnvelope` LONGTEXT NULL,
    `sessionLifecycleEventsJson` LONGTEXT NULL,
    `sessionLifecyclePolicyKind` ENUM('currentTurn', 'firstMatch', 'nextMatches', 'everyMatch') NULL,
    `sessionLifecycleMatchCount` INTEGER NULL,
    `remainingOccurrences` INTEGER NULL,
    `sourceSessionId` VARCHAR(191) NULL,
    `sourceTurnId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`),
    CONSTRAINT `AutomationTrigger_automationId_fkey`
        FOREIGN KEY (`automationId`) REFERENCES `Automation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `AutomationTrigger_arm_check` CHECK (
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
    ),
    INDEX `AutomationTrigger_automationId_enabled_updatedAt_idx`(`automationId`, `enabled`, `updatedAt`),
    INDEX `AutomationTrigger_event_lookup_idx`(`enabled`, `kind`, `eventPluginId`, `eventLocalId`),
    INDEX `AutomationTrigger_watcher_lookup_idx`(`enabled`, `watcherMachineId`, `watcherMaterializationId`),
    INDEX `AutomationTrigger_schedule_due_idx`(`kind`, `enabled`, `deletedAt`, `nextRunAt`, `id`),
    INDEX `AutomationTrigger_session_lifecycle_lookup_idx`(`sourceSessionId`, `sourceTurnId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `AutomationTrigger` (
    `id`, `automationId`, `kind`, `enabled`, `scheduleKind`, `scheduleExpr`,
    `everyMs`, `timezone`, `nextRunAt`, `createdAt`, `updatedAt`
)
SELECT `id`, `id`, 'schedule', true, `scheduleKind`, `scheduleExpr`,
    `everyMs`, `timezone`, `nextRunAt`, `createdAt`, `updatedAt`
FROM `Automation`
WHERE `scheduleKind` IN ('cron', 'interval');

UPDATE `AutomationRun` AS run SET
    run.`triggerId` = CASE WHEN run.`idempotencyKey` IS NULL AND run.`dueAt` <> run.`scheduledAt` THEN run.`automationId` ELSE NULL END,
    run.`causeKind` = CASE WHEN run.`idempotencyKey` IS NOT NULL OR run.`dueAt` = run.`scheduledAt` THEN 'manual' ELSE 'trigger' END,
    run.`causeTriggerKind` = CASE WHEN run.`idempotencyKey` IS NULL AND run.`dueAt` <> run.`scheduledAt` THEN 'schedule' ELSE NULL END,
    run.`causeTriggerRevision` = CASE WHEN run.`idempotencyKey` IS NULL AND run.`dueAt` <> run.`scheduledAt` THEN 0 ELSE NULL END,
    run.`causeOccurredAt` = CASE WHEN run.`idempotencyKey` IS NULL AND run.`dueAt` <> run.`scheduledAt` THEN run.`dueAt` ELSE run.`createdAt` END,
    run.`causeScheduledFor` = CASE WHEN run.`idempotencyKey` IS NULL AND run.`dueAt` <> run.`scheduledAt` THEN run.`dueAt` ELSE NULL END,
    run.`occurrenceKey` = CASE WHEN run.`idempotencyKey` IS NULL AND run.`dueAt` <> run.`scheduledAt`
        THEN LEFT(CONCAT(run.`id`, '_', run.`automationId`, '___________________________________________'), 43)
        ELSE NULL END,
    run.`resultEnvelope` = CASE WHEN run.`summaryCiphertext` IS NOT NULL
        THEN JSON_OBJECT('t', 'legacySummaryCiphertext', 'c', run.`summaryCiphertext`)
        ELSE NULL END;

ALTER TABLE `Automation`
    DROP INDEX `Automation_accountId_nextRunAt_idx`,
    DROP COLUMN `scheduleKind`,
    DROP COLUMN `scheduleExpr`,
    DROP COLUMN `everyMs`,
    DROP COLUMN `timezone`,
    DROP COLUMN `nextRunAt`;

ALTER TABLE `AutomationRun`
    DROP FOREIGN KEY `AutomationRun_automationId_fkey`;
ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_automationId_fkey`
        FOREIGN KEY (`automationId`) REFERENCES `Automation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_cause_arm_check` CHECK (
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
            AND `triggerId` IS NULL AND `causeTriggerKind` IS NULL
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
    );

-- MySQL cannot CHECK producedSessionId because its FK has referential actions.
-- Enforce the complete input invariant at both provider write boundaries.
CREATE TRIGGER `AutomationRun_execution_input_insert`
BEFORE INSERT ON `AutomationRun`
FOR EACH ROW
BEGIN
IF NOT (
    NEW.`state` NOT IN ('queued', 'claimed', 'running')
    OR NEW.`executionInputEnvelope` IS NOT NULL
    OR (NEW.`state` IN ('queued', 'claimed') AND NEW.`startedAt` IS NULL
        AND NEW.`finishedAt` IS NULL AND NEW.`producedSessionId` IS NULL
        AND NEW.`summaryCiphertext` IS NULL AND NEW.`resultEnvelope` IS NULL
        AND NEW.`executionAttempt` = 0 AND NEW.`executionDispatchCommittedAt` IS NULL
        AND (NEW.`executionDispatchState` IS NULL OR NEW.`executionDispatchState` = 'notStarted')
        AND NEW.`executionNativeRunId` IS NULL AND NEW.`executionNativeCallId` IS NULL
        AND NEW.`executionNativeSidechainId` IS NULL)
) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AutomationRun execution input is required';
END IF;
END;

CREATE TRIGGER `AutomationRun_execution_input_update`
BEFORE UPDATE ON `AutomationRun`
FOR EACH ROW
BEGIN
IF NOT (
    NEW.`state` NOT IN ('queued', 'claimed', 'running')
    OR NEW.`executionInputEnvelope` IS NOT NULL
    OR (NEW.`state` IN ('queued', 'claimed') AND NEW.`startedAt` IS NULL
        AND NEW.`finishedAt` IS NULL AND NEW.`producedSessionId` IS NULL
        AND NEW.`summaryCiphertext` IS NULL AND NEW.`resultEnvelope` IS NULL
        AND NEW.`executionAttempt` = 0 AND NEW.`executionDispatchCommittedAt` IS NULL
        AND (NEW.`executionDispatchState` IS NULL OR NEW.`executionDispatchState` = 'notStarted')
        AND NEW.`executionNativeRunId` IS NULL AND NEW.`executionNativeCallId` IS NULL
        AND NEW.`executionNativeSidechainId` IS NULL)
) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AutomationRun execution input is required';
END IF;
END;

ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_reply_handoff_arm_check` CHECK (
        (`causeKind` = 'conversation' AND `replyContextEnvelope` IS NOT NULL
            AND `replyHandoffActionPluginId` IS NOT NULL AND `replyHandoffActionLocalId` IS NOT NULL
            AND `replyHandoffTargetMachineId` IS NOT NULL AND `replyHandoffTargetMachineInstallationId` IS NOT NULL
            AND `replyHandoffTargetMaterializationId` IS NOT NULL AND `replyHandoffId` IS NOT NULL
            AND `replyHandoffState` <> 'none')
        OR (`causeKind` IN ('trigger', 'manual', 'conversation')
            AND `replyContextEnvelope` IS NULL
            AND `replyHandoffActionPluginId` IS NULL AND `replyHandoffActionLocalId` IS NULL
            AND `replyHandoffTargetMachineId` IS NULL AND `replyHandoffTargetMachineInstallationId` IS NULL
            AND `replyHandoffTargetMaterializationId` IS NULL AND `replyHandoffId` IS NULL
            AND `replyHandoffState` = 'none' AND `replyHandoffAttempt` = 0
            AND `replyHandoffDueAt` IS NULL)
    );

CREATE TABLE `AutomationEventCatalogState` (
    `accountId` VARCHAR(191) NOT NULL,
    `eventSourceDefinitionsRevision` BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (`accountId`),
    CONSTRAINT `AutomationEventCatalogState_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AutomationEventSourceStatus` (
    `triggerId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `eventPluginId` VARCHAR(191) NOT NULL,
    `eventLocalId` VARCHAR(191) NOT NULL,
    `sourceSelectorId` VARCHAR(191) NOT NULL,
    `triggerRevision` INTEGER NOT NULL,
    `reporterMachineId` VARCHAR(191) NOT NULL,
    `reporterMachineInstallationId` VARCHAR(191) NOT NULL,
    `reporterMaterializationId` VARCHAR(191) NOT NULL,
    `reporterSourceCustody` JSON NOT NULL,
    `state` ENUM('uninitialized', 'baselined', 'observing', 'backingOff', 'attention') NOT NULL,
    `code` VARCHAR(191) NULL,
    `lastObservedAt` DATETIME(3) NULL,
    `lastDispositionAt` DATETIME(3) NULL,
    `nextRetryAt` DATETIME(3) NULL,
    `observedCount` INTEGER NOT NULL DEFAULT 0,
    `admittedCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `revision` INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (`triggerId`),
    INDEX `AutomationEventSourceStatus_state_nextRetryAt_idx`(`state`, `nextRetryAt`),
    CONSTRAINT `AutomationEventSourceStatus_triggerId_fkey`
        FOREIGN KEY (`triggerId`) REFERENCES `AutomationTrigger`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AutomationEventSourceCatalogStatus` (
    `accountId` VARCHAR(191) NOT NULL,
    -- Primary-key member: a case-insensitive collation would fold two distinct
    -- author plugin IDs into one catalog-status row per scope.
    `eventPluginId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `reporterMachineId` VARCHAR(191) NOT NULL,
    `reporterMachineInstallationId` VARCHAR(191) NOT NULL,
    `reporterMaterializationId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `reporterSourceCustody` JSON NOT NULL,
    `scopeKey` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `observedRevision` BIGINT NOT NULL,
    `adoptedRevision` BIGINT NULL,
    `state` ENUM('current', 'reconciling', 'reconciliationLate') NOT NULL,
    `scanStartedAt` DATETIME(3) NULL,
    `nextRetryAt` DATETIME(3) NULL,
    `reportedAt` DATETIME(3) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (`accountId`, `eventPluginId`, `reporterMaterializationId`, `scopeKey`),
    INDEX `AutomationEventSourceCatalogStatus_state_reportedAt_idx`(`state`, `reportedAt`),
    CONSTRAINT `AutomationEventSourceCatalogStatus_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AutomationRunAssignment` (
    `runId` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (`runId`, `machineId`),
    INDEX `AutomationRunAssignment_machineId_priority_idx`(`machineId`, `priority`),
    CONSTRAINT `AutomationRunAssignment_runId_fkey`
        FOREIGN KEY (`runId`) REFERENCES `AutomationRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AutomationWorkerClaimReceipt` (
    `id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `machineInstallationId` VARCHAR(191) NOT NULL,
    -- The strict V3 claim result owns the whole committed outcome, including
    -- the nullable claimed Run id/attempt and the currentness projection.
    -- Shadow columns for those facts would be a second outcome owner.
    `claimResultJson` LONGTEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `AutomationWorkerClaimReceipt_accountId_machineId_idx`(`accountId`, `machineId`),
    INDEX `AutomationWorkerClaimReceipt_expiresAt_idx`(`expiresAt`),
    CONSTRAINT `AutomationWorkerClaimReceipt_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `AutomationRunAssignment` (`runId`, `machineId`, `priority`)
SELECT run.`id`, assignment.`machineId`, assignment.`priority`
FROM `AutomationRun` AS run
INNER JOIN `AutomationAssignment` AS assignment ON assignment.`automationId` = run.`automationId`
WHERE assignment.`enabled` = true;

-- The one ordinary nullable composite unique that owns Run rejoin for every
-- cause. Trigger identity is already inside the derived occurrence key, so a
-- trigger- or cause-scoped unique would be a second dedupe owner.
ALTER TABLE `AutomationRun`
    ADD UNIQUE INDEX `AutomationRun_automationId_occurrenceKey_key`(`automationId`, `occurrenceKey`),
    ADD INDEX `AutomationRun_accountId_causeKind_state_idx`(`accountId`, `causeKind`, `state`),
    ADD INDEX `AutomationRun_state_dueAt_idx`(`state`, `dueAt`),
    ADD INDEX `AutomationRun_replyHandoffState_replyHandoffDueAt_idx`(`replyHandoffState`, `replyHandoffDueAt`),
    ADD INDEX `AutomationRun_triggerId_state_idx`(`triggerId`, `state`);
