-- Released V2 open Runs have no frozen recipe bytes. The duplicate primary-key
-- insert is a hard failure until the released worker has drained or cancelled
-- them and predecessor writers are excluded.
CREATE TEMPORARY TABLE `_AutomationRun_open_frozen_input_preflight` (
    `ok` TINYINT NOT NULL PRIMARY KEY
);
INSERT INTO `_AutomationRun_open_frozen_input_preflight` (`ok`)
SELECT 1
UNION ALL
SELECT 1 FROM DUAL WHERE EXISTS (
    SELECT 1 FROM `AutomationRun` WHERE `state` IN ('queued', 'claimed', 'running')
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
    ADD COLUMN `causeSessionLifecycleEvent` ENUM('parentTurnCompleted') NULL,
    ADD COLUMN `causeSourceSessionId` VARCHAR(191) NULL,
    ADD COLUMN `causeSourceTurnId` VARCHAR(191) NULL,
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
    ADD COLUMN `replyHandoffReceiptEnvelope` LONGTEXT NULL,
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
    `observationTransport` ENUM('checkpointedPull', 'durablePush') NULL,
    `webhookEndpointId` VARCHAR(191) NULL,
    `observationStartsAt` DATETIME(3) NULL,
    `watcherMachineId` VARCHAR(191) NULL,
    `watcherMachineInstallationId` VARCHAR(191) NULL,
    `watcherPluginId` VARCHAR(191) NULL,
    `watcherMaterializationId` VARCHAR(191) NULL,
    `definitionEnvelope` LONGTEXT NULL,
    `sessionLifecycleEvent` ENUM('parentTurnCompleted') NULL,
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
            AND `sessionLifecycleEvent` IS NULL AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL)
        OR (`deletedAt` IS NOT NULL AND `enabled` = false AND `kind` = 'pluginEvent'
            AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL AND `everyMs` IS NULL
            AND `timezone` IS NULL AND `nextRunAt` IS NULL
            AND `eventPluginId` IS NOT NULL AND `eventLocalId` IS NOT NULL
            AND `sourceSelectorId` IS NOT NULL AND `sourceContractVersion` IS NOT NULL
            AND `definitionEnvelope` IS NULL AND `observationTransport` IS NULL
            AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL
            AND `sessionLifecycleEvent` IS NULL AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL)
        OR (`deletedAt` IS NULL AND `kind` = 'schedule' AND `scheduleKind` IS NOT NULL
            AND ((`scheduleKind` = 'cron' AND `scheduleExpr` IS NOT NULL AND `everyMs` IS NULL)
                OR (`scheduleKind` = 'interval' AND `scheduleExpr` IS NULL AND `everyMs` IS NOT NULL))
            AND `eventPluginId` IS NULL AND `eventLocalId` IS NULL AND `sourceSelectorId` IS NULL
            AND `sourceContractVersion` IS NULL AND `observationTransport` IS NULL
            AND `webhookEndpointId` IS NULL AND `observationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL
            AND `definitionEnvelope` IS NULL
            AND `sessionLifecycleEvent` IS NULL AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL)
        OR (`deletedAt` IS NULL AND `kind` = 'pluginEvent' AND `scheduleKind` IS NULL AND `scheduleExpr` IS NULL
            AND `everyMs` IS NULL AND `timezone` IS NULL AND `nextRunAt` IS NULL
            AND `eventPluginId` IS NOT NULL AND `eventLocalId` IS NOT NULL
            AND `sourceSelectorId` IS NOT NULL AND `sourceContractVersion` IS NOT NULL
            AND `observationTransport` IS NOT NULL
            AND `definitionEnvelope` IS NOT NULL
            AND `sessionLifecycleEvent` IS NULL AND `sourceSessionId` IS NULL AND `sourceTurnId` IS NULL
            AND ((`observationTransport` = 'checkpointedPull' AND `webhookEndpointId` IS NULL
                    AND `observationStartsAt` IS NULL
                    AND ((`watcherMachineId` IS NULL AND `watcherMachineInstallationId` IS NULL
                            AND `watcherPluginId` IS NULL AND `watcherMaterializationId` IS NULL)
                        OR (`watcherMachineId` IS NOT NULL AND `watcherMachineInstallationId` IS NOT NULL
                            AND `watcherPluginId` IS NOT NULL AND `watcherMaterializationId` IS NOT NULL)))
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
            AND `sessionLifecycleEvent` IS NOT NULL
            AND `sessionLifecycleEvent` = 'parentTurnCompleted'
            AND `sourceSessionId` IS NOT NULL AND `sourceTurnId` IS NOT NULL)
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
FROM `Automation`;

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
                    AND `causeSourceSelectorId` IS NULL AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL)
                OR (`causeTriggerKind` = 'pluginEvent' AND `causeEventPluginId` IS NOT NULL AND `causeEventLocalId` IS NOT NULL
                    AND `causeScheduledFor` IS NULL
                    AND `causeSessionLifecycleEvent` IS NULL AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL
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
                    AND `causeSessionLifecycleEvent` IS NOT NULL
                    AND `causeSessionLifecycleEvent` = 'parentTurnCompleted' AND `causeSourceSessionId` IS NOT NULL
                    AND `causeSourceTurnId` IS NOT NULL AND `causeSourceSelectorId` IS NULL
                    AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL)
            ))
        OR (`causeKind` = 'manual' AND `triggerId` IS NULL AND `causeTriggerKind` IS NULL
            AND `causeTriggerRevision` IS NULL AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL
            AND `causeOccurredAt` IS NOT NULL AND `causeScheduledFor` IS NULL AND `causeSessionLifecycleEvent` IS NULL
            AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL
            AND `occurrenceKey` IS NULL AND `causeSourceSelectorId` IS NULL
            AND `triggerEvidenceEnvelope` IS NULL AND `occurrenceEvidenceEqualityTag` IS NULL)
        OR (`causeKind` = 'conversation' AND `idempotencyKey` IS NULL
            AND `triggerId` IS NULL AND `causeTriggerKind` IS NULL
            AND `causeTriggerRevision` IS NULL AND `causeEventPluginId` IS NULL AND `causeEventLocalId` IS NULL
            AND `causeOccurredAt` IS NOT NULL AND `causeScheduledFor` IS NULL AND `causeSessionLifecycleEvent` IS NULL
            AND `causeSourceSessionId` IS NULL AND `causeSourceTurnId` IS NULL
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

ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_execution_input_arm_check` CHECK (
        `state` NOT IN ('queued', 'claimed', 'running')
        OR `executionInputEnvelope` IS NOT NULL
    );

ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_reply_handoff_arm_check` CHECK (
        (`causeKind` = 'conversation' AND `replyContextEnvelope` IS NOT NULL
            AND `replyHandoffActionPluginId` IS NOT NULL AND `replyHandoffActionLocalId` IS NOT NULL
            AND `replyHandoffTargetMachineId` IS NOT NULL AND `replyHandoffTargetMachineInstallationId` IS NOT NULL
            AND `replyHandoffTargetMaterializationId` IS NOT NULL AND `replyHandoffId` IS NOT NULL
            AND `replyHandoffState` <> 'none')
        OR (`causeKind` IN ('trigger', 'manual')
            AND `replyContextEnvelope` IS NULL
            AND `replyHandoffActionPluginId` IS NULL AND `replyHandoffActionLocalId` IS NULL
            AND `replyHandoffTargetMachineId` IS NULL AND `replyHandoffTargetMachineInstallationId` IS NULL
            AND `replyHandoffTargetMaterializationId` IS NULL AND `replyHandoffId` IS NULL
            AND `replyHandoffState` = 'none' AND `replyHandoffAttempt` = 0
            AND `replyHandoffDueAt` IS NULL AND `replyHandoffReceiptEnvelope` IS NULL)
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
    `reporterImmutableGenerationId` VARCHAR(256) NOT NULL,
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
    `eventPluginId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `reporterMachineId` VARCHAR(191) NOT NULL,
    `reporterMachineInstallationId` VARCHAR(191) NOT NULL,
    `reporterMaterializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `reporterImmutableGenerationId` VARCHAR(256) NOT NULL,
    `scopeKey` VARCHAR(191) NOT NULL,
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
    `runId` VARCHAR(191) NULL,
    `claimedAttempt` INTEGER NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    INDEX `AutomationWorkerClaimReceipt_accountId_machineId_idx`(`accountId`, `machineId`),
    INDEX `AutomationWorkerClaimReceipt_expiresAt_idx`(`expiresAt`),
    CONSTRAINT `AutomationWorkerClaimReceipt_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `AutomationWorkerClaimReceipt_outcome_check` CHECK (
        (`runId` IS NULL AND `claimedAttempt` IS NULL)
        OR (`runId` IS NOT NULL AND `claimedAttempt` IS NOT NULL AND `claimedAttempt` > 0)
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `AutomationRunAssignment` (`runId`, `machineId`, `priority`)
SELECT run.`id`, assignment.`machineId`, assignment.`priority`
FROM `AutomationRun` AS run
INNER JOIN `AutomationAssignment` AS assignment ON assignment.`automationId` = run.`automationId`
WHERE assignment.`enabled` = true;

ALTER TABLE `AutomationRun`
    ADD UNIQUE INDEX `AutomationRun_triggerId_occurrenceKey_key`(`triggerId`, `occurrenceKey`),
    ADD UNIQUE INDEX `AutomationRun_automationId_causeKind_occurrenceKey_key`(`automationId`, `causeKind`, `occurrenceKey`),
    ADD INDEX `AutomationRun_accountId_causeKind_state_idx`(`accountId`, `causeKind`, `state`),
    ADD INDEX `AutomationRun_state_dueAt_idx`(`state`, `dueAt`),
    ADD INDEX `AutomationRun_replyHandoffState_replyHandoffDueAt_idx`(`replyHandoffState`, `replyHandoffDueAt`),
    ADD INDEX `AutomationRun_triggerId_state_idx`(`triggerId`, `state`);
