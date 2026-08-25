ALTER TABLE `Automation`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `triggerKind` ENUM('schedule', 'manual', 'pluginEvent') NOT NULL DEFAULT 'schedule',
    ADD COLUMN `triggerEventPluginId` VARCHAR(191) NULL,
    ADD COLUMN `triggerEventLocalId` VARCHAR(191) NULL,
    ADD COLUMN `triggerSourceSelectorId` VARCHAR(191) NULL,
    ADD COLUMN `triggerSourceContractVersion` INTEGER NULL,
    ADD COLUMN `triggerObservationTransport` ENUM('checkpointedPull', 'durablePush') NULL,
    ADD COLUMN `triggerWebhookEndpointId` VARCHAR(191) NULL,
    ADD COLUMN `triggerObservationStartsAt` DATETIME(3) NULL,
    ADD COLUMN `watcherMachineId` VARCHAR(191) NULL,
    ADD COLUMN `watcherMachineInstallationId` VARCHAR(191) NULL,
    ADD COLUMN `watcherPluginId` VARCHAR(191) NULL,
    ADD COLUMN `watcherMaterializationId` VARCHAR(191) NULL,
    ADD COLUMN `triggerDefinitionEnvelope` LONGTEXT NULL;

ALTER TABLE `AutomationRun`
    ADD COLUMN `originKind` ENUM('scheduled', 'manual', 'pluginEvent', 'conversation') NOT NULL DEFAULT 'scheduled',
    ADD COLUMN `originOccurredAt` DATETIME(3) NULL,
    ADD COLUMN `occurrenceKey` CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN `occurrenceEvidenceEqualityTag` VARCHAR(191) NULL,
    ADD COLUMN `originSourceSelectorId` VARCHAR(191) NULL,
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

-- V2 keeps its incumbent `scheduledAt` wire projection. V3 Event and
-- Conversation projections use their separately retained source occurrence time.
-- The preview predecessor represented manual definitions as a schedule arm.
-- Adopt those rows before narrowing the schedule enum to the V3 schedule arm.
UPDATE `AutomationRun` AS run
INNER JOIN `Automation` AS automation ON automation.`id` = run.`automationId`
SET run.`originKind` = 'manual'
WHERE automation.`scheduleKind` = 'manual';

UPDATE `Automation`
SET
    `triggerKind` = 'manual',
    `scheduleKind` = NULL,
    `scheduleExpr` = NULL,
    `everyMs` = NULL,
    `timezone` = NULL,
    `nextRunAt` = NULL
WHERE `scheduleKind` = 'manual';

ALTER TABLE `Automation`
    MODIFY `scheduleKind` ENUM('cron', 'interval') NULL;
ALTER TABLE `Automation`
    MODIFY `targetType` ENUM('new_session', 'existing_session', 'execution_run') NOT NULL;
ALTER TABLE `AutomationRun`
    MODIFY `scheduledAt` DATETIME(3) NOT NULL;
ALTER TABLE `AutomationRun`
    DROP FOREIGN KEY `AutomationRun_automationId_fkey`;
ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_automationId_fkey`
        FOREIGN KEY (`automationId`) REFERENCES `Automation`(`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- The definition-trigger and Run-origin unions are physical constraints. Keep impossible
-- combinations out of the database even if a future caller bypasses an
-- application-level validator.
ALTER TABLE `Automation`
    ADD CONSTRAINT `Automation_trigger_arm_check`
    CHECK (
        (
            `triggerKind` = 'schedule'
            AND `scheduleKind` IS NOT NULL
            AND `triggerEventPluginId` IS NULL
            AND `triggerEventLocalId` IS NULL
            AND `triggerSourceSelectorId` IS NULL
            AND `triggerSourceContractVersion` IS NULL
            AND `triggerObservationTransport` IS NULL
            AND `triggerWebhookEndpointId` IS NULL
            AND `triggerObservationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL
            AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL
            AND `watcherMaterializationId` IS NULL
            AND `triggerDefinitionEnvelope` IS NULL
        )
        OR
        (
            `triggerKind` = 'manual'
            AND `scheduleKind` IS NULL
            AND `triggerEventPluginId` IS NULL
            AND `triggerEventLocalId` IS NULL
            AND `triggerSourceSelectorId` IS NULL
            AND `triggerSourceContractVersion` IS NULL
            AND `triggerObservationTransport` IS NULL
            AND `triggerWebhookEndpointId` IS NULL
            AND `triggerObservationStartsAt` IS NULL
            AND `watcherMachineId` IS NULL
            AND `watcherMachineInstallationId` IS NULL
            AND `watcherPluginId` IS NULL
            AND `watcherMaterializationId` IS NULL
            AND `triggerDefinitionEnvelope` IS NULL
        )
        OR
        (
            `triggerKind` = 'pluginEvent'
            AND `scheduleKind` IS NULL
            AND `triggerEventPluginId` IS NOT NULL
            AND `triggerEventLocalId` IS NOT NULL
            AND `triggerSourceSelectorId` IS NOT NULL
            AND `triggerSourceContractVersion` IS NOT NULL
            AND `triggerDefinitionEnvelope` IS NOT NULL
            AND (
                (
                    `triggerObservationTransport` = 'checkpointedPull'
                    AND `triggerWebhookEndpointId` IS NULL
                    AND `triggerObservationStartsAt` IS NULL
                    AND (
                        (
                            `watcherMachineId` IS NULL
                            AND `watcherMachineInstallationId` IS NULL
                            AND `watcherPluginId` IS NULL
                            AND `watcherMaterializationId` IS NULL
                        )
                        OR
                        (
                            `watcherMachineId` IS NOT NULL
                            AND `watcherMachineInstallationId` IS NOT NULL
                            AND `watcherPluginId` IS NOT NULL
                            AND `watcherMaterializationId` IS NOT NULL
                        )
                    )
                )
                OR
                (
                    `triggerObservationTransport` = 'durablePush'
                    AND `triggerWebhookEndpointId` IS NOT NULL
                    AND `triggerObservationStartsAt` IS NOT NULL
                    AND `watcherMachineId` IS NULL
                    AND `watcherMachineInstallationId` IS NULL
                    AND `watcherPluginId` IS NULL
                    AND `watcherMaterializationId` IS NULL
                )
            )
    );

ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_origin_arm_check`
    CHECK (
        (
            `originKind` = 'scheduled'
            AND `originOccurredAt` IS NULL
            AND `occurrenceKey` IS NULL
            AND `occurrenceEvidenceEqualityTag` IS NULL
            AND `originSourceSelectorId` IS NULL
            AND `triggerEvidenceEnvelope` IS NULL
        )
        OR
        (
            `originKind` = 'manual'
            AND `originOccurredAt` IS NULL
            AND `occurrenceEvidenceEqualityTag` IS NULL
            AND `originSourceSelectorId` IS NULL
            AND `triggerEvidenceEnvelope` IS NULL
        )
        OR
        (
            `originKind` = 'pluginEvent'
            AND `originOccurredAt` IS NOT NULL
            AND `occurrenceKey` IS NOT NULL
            AND `originSourceSelectorId` IS NOT NULL
            AND `triggerEvidenceEnvelope` IS NOT NULL
            AND (
                (
                    COALESCE(
                        JSON_UNQUOTE(JSON_EXTRACT(
                            CASE
                                WHEN JSON_VALID(`triggerEvidenceEnvelope`) THEN `triggerEvidenceEnvelope`
                                ELSE NULL
                            END,
                            '$.t'
                        )) = 'plain',
                        FALSE
                    )
                    AND `occurrenceEvidenceEqualityTag` IS NULL
                )
                OR
                (
                    COALESCE(
                        JSON_UNQUOTE(JSON_EXTRACT(
                            CASE
                                WHEN JSON_VALID(`triggerEvidenceEnvelope`) THEN `triggerEvidenceEnvelope`
                                ELSE NULL
                            END,
                            '$.t'
                        )) = 'encrypted',
                        FALSE
                    )
                    AND `occurrenceEvidenceEqualityTag` IS NOT NULL
                    AND CHAR_LENGTH(`occurrenceEvidenceEqualityTag`) = 43
                    AND `occurrenceEvidenceEqualityTag` REGEXP '^[A-Za-z0-9_-]{43}$'
                )
            )
        )
        OR
        (
            `originKind` = 'conversation'
            AND `originOccurredAt` IS NOT NULL
            AND `occurrenceKey` IS NOT NULL
            AND `originSourceSelectorId` IS NULL
            AND `triggerEvidenceEnvelope` IS NOT NULL
            AND (
                (
                    COALESCE(
                        JSON_UNQUOTE(JSON_EXTRACT(
                            CASE
                                WHEN JSON_VALID(`triggerEvidenceEnvelope`) THEN `triggerEvidenceEnvelope`
                                ELSE NULL
                            END,
                            '$.t'
                        )) = 'plain',
                        FALSE
                    )
                    AND `occurrenceEvidenceEqualityTag` IS NULL
                )
                OR
                (
                    COALESCE(
                        JSON_UNQUOTE(JSON_EXTRACT(
                            CASE
                                WHEN JSON_VALID(`triggerEvidenceEnvelope`) THEN `triggerEvidenceEnvelope`
                                ELSE NULL
                            END,
                            '$.t'
                        )) = 'encrypted',
                        FALSE
                    )
                    AND `occurrenceEvidenceEqualityTag` IS NOT NULL
                    AND CHAR_LENGTH(`occurrenceEvidenceEqualityTag`) = 43
                    AND `occurrenceEvidenceEqualityTag` REGEXP '^[A-Za-z0-9_-]{43}$'
                )
            )
        )
    );

ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_reply_handoff_arm_check`
    CHECK (
        (
            `originKind` = 'conversation'
            AND `replyContextEnvelope` IS NOT NULL
            AND `replyHandoffActionPluginId` IS NOT NULL
            AND `replyHandoffActionLocalId` IS NOT NULL
            AND `replyHandoffTargetMachineId` IS NOT NULL
            AND `replyHandoffTargetMachineInstallationId` IS NOT NULL
            AND `replyHandoffTargetMaterializationId` IS NOT NULL
            AND `replyHandoffId` IS NOT NULL
            AND `replyHandoffState` <> 'none'
        )
        OR
        (
            `originKind` IN ('scheduled', 'manual', 'pluginEvent', 'conversation')
            AND `replyContextEnvelope` IS NULL
            AND `replyHandoffActionPluginId` IS NULL
            AND `replyHandoffActionLocalId` IS NULL
            AND `replyHandoffTargetMachineId` IS NULL
            AND `replyHandoffTargetMachineInstallationId` IS NULL
            AND `replyHandoffTargetMaterializationId` IS NULL
            AND `replyHandoffId` IS NULL
            AND `replyHandoffState` = 'none'
            AND `replyHandoffAttempt` = 0
            AND `replyHandoffDueAt` IS NULL
            AND `replyHandoffReceiptEnvelope` IS NULL
        )
    );

UPDATE `AutomationRun`
SET `resultEnvelope` = JSON_OBJECT(
    't', 'legacySummaryCiphertext',
    'c', `summaryCiphertext`
)
WHERE `summaryCiphertext` IS NOT NULL;

CREATE TABLE `AutomationEventCatalogState` (
    `accountId` VARCHAR(191) NOT NULL,
    `eventSourceDefinitionsRevision` BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (`accountId`),
    CONSTRAINT `AutomationEventCatalogState_accountId_fkey`
        FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AutomationEventSourceStatus` (
    `automationId` VARCHAR(191) NOT NULL,
    `eventPluginId` VARCHAR(191) NOT NULL,
    `eventLocalId` VARCHAR(191) NOT NULL,
    `sourceSelectorId` VARCHAR(191) NOT NULL,
    `templateVersion` INTEGER NOT NULL,
    `reporterMachineId` VARCHAR(191) NOT NULL,
    `reporterMachineInstallationId` VARCHAR(191) NOT NULL,
    `reporterMaterializationId` VARCHAR(191) NOT NULL,
    `state` ENUM('uninitialized', 'baselined', 'observing', 'backingOff', 'attention') NOT NULL,
    `code` VARCHAR(191) NULL,
    `lastObservedAt` DATETIME(3) NULL,
    `lastDispositionAt` DATETIME(3) NULL,
    `nextRetryAt` DATETIME(3) NULL,
    `observedCount` INTEGER NOT NULL DEFAULT 0,
    `admittedCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `revision` INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (`automationId`, `eventPluginId`, `eventLocalId`, `sourceSelectorId`),
    INDEX `AutomationEventSourceStatus_state_nextRetryAt_idx`(`state`, `nextRetryAt`),
    CONSTRAINT `AutomationEventSourceStatus_automationId_fkey`
        FOREIGN KEY (`automationId`) REFERENCES `Automation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AutomationEventSourceCatalogStatus` (
    `accountId` VARCHAR(191) NOT NULL,
    `eventPluginId` VARCHAR(191) NOT NULL,
    `reporterMachineId` VARCHAR(191) NOT NULL,
    `reporterMachineInstallationId` VARCHAR(191) NOT NULL,
    `reporterMaterializationId` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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

ALTER TABLE `AutomationRun`
    ADD UNIQUE INDEX `AutomationRun_automationId_occurrenceKey_key`(`automationId`, `occurrenceKey`),
    ADD INDEX `AutomationRun_accountId_originKind_state_idx`(`accountId`, `originKind`, `state`),
    ADD INDEX `AutomationRun_state_dueAt_idx`(`state`, `dueAt`),
    ADD INDEX `AutomationRun_replyHandoffState_replyHandoffDueAt_idx`(`replyHandoffState`, `replyHandoffDueAt`);
ALTER TABLE `Automation`
    ADD INDEX `Automation_event_trigger_lookup_idx`(`accountId`, `enabled`, `triggerKind`, `triggerEventPluginId`, `triggerEventLocalId`),
    ADD INDEX `Automation_watcher_materialization_lookup_idx`(`accountId`, `enabled`, `watcherMachineId`, `watcherMaterializationId`);
