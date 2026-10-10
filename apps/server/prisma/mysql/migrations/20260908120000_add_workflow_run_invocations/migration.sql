ALTER TABLE `AccountEncryptionTransitionAutomationStage`
    DROP CHECK `AETAS_kind_ck`,
    DROP CHECK `AETAS_currentness_ck`,
    MODIFY `participantKind` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    MODIFY `automationId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    MODIFY `sourceRevision` INTEGER NULL,
    ADD CONSTRAINT `AETAS_kind_ck`
        CHECK (`participantKind` IN ('definition', 'run', 'workflow_invocation')),
    ADD CONSTRAINT `AETAS_currentness_ck`
        CHECK (
            (`participantKind` = 'definition' AND `automationId` IS NOT NULL AND `sourceRevision` >= 0)
            OR (`participantKind` = 'run' AND `sourceRevision` >= 0)
            OR (`participantKind` = 'workflow_invocation' AND `automationId` IS NULL AND `sourceRevision` IS NULL)
        );

ALTER TABLE `Automation` MODIFY `targetType` ENUM('new_session', 'existing_session', 'execution_run') NULL;

ALTER TABLE `AutomationRun`
    MODIFY `automationId` VARCHAR(191) NULL,
    MODIFY `causeKind` ENUM('trigger', 'manual', 'conversation') NULL DEFAULT 'trigger',
    MODIFY `state` ENUM('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'dispatch_failed', 'skipped', 'missed', 'outcome_uncertain', 'pause_requested', 'paused', 'interrupted', 'waiting_for_review') NOT NULL DEFAULT 'queued',
    ADD COLUMN `originKind` VARCHAR(191) NOT NULL DEFAULT 'automation',
    ADD COLUMN `originSessionId` VARCHAR(191) NULL,
    ADD COLUMN `workflowAcceptedSnapshotEnvelope` LONGTEXT NULL,
    ADD COLUMN `workflowCheckpointEnvelope` LONGTEXT NULL,
    ADD COLUMN `workflowCustodyState` ENUM('pending', 'settled') NULL,
    ADD COLUMN `workflowResumeRequestedRevision` INTEGER NULL,
    ADD COLUMN `originDeliveryAckRevision` INTEGER NULL,
    ADD COLUMN `visibleTeamId` VARCHAR(191) NULL,
    ADD CONSTRAINT `AutomationRun_originSessionId_fkey` FOREIGN KEY (`originSessionId`) REFERENCES `Session`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `WorkflowRunInvocation` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `sequence` BIGINT NOT NULL,
    `parentRecordId` VARCHAR(191) NULL,
    `memberOrdinal` BIGINT NOT NULL,
    `attempt` BIGINT NOT NULL DEFAULT 0,
    `contentRevision` BIGINT NOT NULL DEFAULT 0,
    `lifecycle` ENUM('pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval', 'waiting_for_review', 'needs_attention', 'completed', 'failed', 'skipped', 'cancel_requested', 'cancelled', 'outcome_uncertain', 'superseded') NOT NULL DEFAULT 'pending',
    `contentEnvelope` LONGTEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`),
    CONSTRAINT `WorkflowRunInvocation_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `AutomationRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WorkflowRunDataKeyEnvelope` (
    `runId` VARCHAR(191) NOT NULL,
    `recipientAccountId` VARCHAR(191) NOT NULL,
    `encryptedDataKey` LONGBLOB NOT NULL,
    `recipientContentPublicKeyFingerprint` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`runId`, `recipientAccountId`),
    CONSTRAINT `WorkflowRunDataKeyEnvelope_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `AutomationRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `WorkflowRunDataKeyEnvelope_recipientAccountId_fkey` FOREIGN KEY (`recipientAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE INDEX `WorkflowRunDataKeyEnvelope_recipientAccountId_idx` ON `WorkflowRunDataKeyEnvelope`(`recipientAccountId`);

CREATE UNIQUE INDEX `WorkflowRunInvocation_run_sequence_key` ON `WorkflowRunInvocation`(`runId`, `sequence`);
CREATE UNIQUE INDEX `WorkflowRunInvocation_slot_attempt_key` ON `WorkflowRunInvocation`(`runId`, `parentRecordId`, `memberOrdinal`, `attempt`);
CREATE INDEX `WorkflowRunInvocation_lifecycle_idx` ON `WorkflowRunInvocation`(`runId`, `lifecycle`, `sequence`);
CREATE INDEX `AutomationRun_account_origin_created_id_idx` ON `AutomationRun`(`accountId`, `originKind`, `createdAt` DESC, `id` DESC);
CREATE INDEX `AutomationRun_account_created_id_idx` ON `AutomationRun`(`accountId`, `createdAt` DESC, `id` DESC);
CREATE INDEX `AutomationRun_originSession_created_id_idx` ON `AutomationRun`(`originSessionId`, `createdAt` DESC, `id` DESC);

-- MySQL rejects a CHECK that reads automationId/originSessionId because both
-- participate in FKs with referential actions (error 3823). Keep the exact
-- origin invariant at the provider write boundary with an explicit error.
CREATE TRIGGER `AutomationRun_origin_kind_insert`
BEFORE INSERT ON `AutomationRun`
FOR EACH ROW
BEGIN
IF NOT (
    (NEW.`originKind` = 'automation' AND NEW.`automationId` IS NOT NULL AND NEW.`causeKind` IS NOT NULL)
    OR (NEW.`originKind` = 'direct'
        AND NEW.`automationId` IS NULL
        AND NEW.`triggerId` IS NULL
        AND NEW.`causeKind` IS NULL
        AND NEW.`causeTriggerKind` IS NULL
        AND NEW.`causeTriggerRevision` IS NULL
        AND NEW.`causeEventPluginId` IS NULL
        AND NEW.`causeEventLocalId` IS NULL
        AND NEW.`causeOccurredAt` IS NULL
        AND NEW.`causeScheduledFor` IS NULL
        AND NEW.`causeSessionLifecycleEvent` IS NULL
        AND NEW.`causeSourceSessionId` IS NULL
        AND NEW.`causeSourceTurnId` IS NULL
        AND NEW.`causeSessionLifecycleRequestId` IS NULL
        AND NEW.`causeSessionLifecycleRequestKind` IS NULL
        AND NEW.`causeSessionLifecyclePolicyKind` IS NULL
        AND NEW.`causeSessionLifecycleConfiguredCount` IS NULL
        AND NEW.`occurrenceKey` IS NULL
        AND NEW.`idempotencyKey` IS NULL
        AND NEW.`occurrenceEvidenceEqualityTag` IS NULL
        AND NEW.`causeSourceSelectorId` IS NULL
        AND NEW.`triggerEvidenceEnvelope` IS NULL
        AND NEW.`replyContextEnvelope` IS NULL
        AND NEW.`replyHandoffActionPluginId` IS NULL
        AND NEW.`replyHandoffActionLocalId` IS NULL
        AND NEW.`replyHandoffTargetMachineId` IS NULL
        AND NEW.`replyHandoffTargetMachineInstallationId` IS NULL
        AND NEW.`replyHandoffTargetMaterializationId` IS NULL
        AND NEW.`replyHandoffId` IS NULL
        AND NEW.`replyHandoffDueAt` IS NULL
        AND NEW.`replyHandoffState` = 'none'
        AND NEW.`replyHandoffAttempt` = 0
        AND NEW.`workflowAcceptedSnapshotEnvelope` IS NOT NULL
        AND NEW.`workflowCustodyState` IS NOT NULL)
) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AutomationRun origin shape is invalid';
END IF;
END;

CREATE TRIGGER `AutomationRun_origin_kind_update`
BEFORE UPDATE ON `AutomationRun`
FOR EACH ROW
BEGIN
IF NOT (
    (NEW.`originKind` = 'automation' AND NEW.`automationId` IS NOT NULL AND NEW.`causeKind` IS NOT NULL)
    OR (NEW.`originKind` = 'direct'
        AND NEW.`automationId` IS NULL
        AND NEW.`triggerId` IS NULL
        AND NEW.`causeKind` IS NULL
        AND NEW.`causeTriggerKind` IS NULL
        AND NEW.`causeTriggerRevision` IS NULL
        AND NEW.`causeEventPluginId` IS NULL
        AND NEW.`causeEventLocalId` IS NULL
        AND NEW.`causeOccurredAt` IS NULL
        AND NEW.`causeScheduledFor` IS NULL
        AND NEW.`causeSessionLifecycleEvent` IS NULL
        AND NEW.`causeSourceSessionId` IS NULL
        AND NEW.`causeSourceTurnId` IS NULL
        AND NEW.`causeSessionLifecycleRequestId` IS NULL
        AND NEW.`causeSessionLifecycleRequestKind` IS NULL
        AND NEW.`causeSessionLifecyclePolicyKind` IS NULL
        AND NEW.`causeSessionLifecycleConfiguredCount` IS NULL
        AND NEW.`occurrenceKey` IS NULL
        AND NEW.`idempotencyKey` IS NULL
        AND NEW.`occurrenceEvidenceEqualityTag` IS NULL
        AND NEW.`causeSourceSelectorId` IS NULL
        AND NEW.`triggerEvidenceEnvelope` IS NULL
        AND NEW.`replyContextEnvelope` IS NULL
        AND NEW.`replyHandoffActionPluginId` IS NULL
        AND NEW.`replyHandoffActionLocalId` IS NULL
        AND NEW.`replyHandoffTargetMachineId` IS NULL
        AND NEW.`replyHandoffTargetMachineInstallationId` IS NULL
        AND NEW.`replyHandoffTargetMaterializationId` IS NULL
        AND NEW.`replyHandoffId` IS NULL
        AND NEW.`replyHandoffDueAt` IS NULL
        AND NEW.`replyHandoffState` = 'none'
        AND NEW.`replyHandoffAttempt` = 0
        AND NEW.`workflowAcceptedSnapshotEnvelope` IS NOT NULL
        AND NEW.`workflowCustodyState` IS NOT NULL)
) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AutomationRun origin shape is invalid';
END IF;
END;

ALTER TABLE `WorkflowRunInvocation` ADD CONSTRAINT `WorkflowRunInvocation_counter_check` CHECK (
    `sequence` >= 0 AND `memberOrdinal` >= 0 AND `attempt` >= 0 AND `contentRevision` >= 0
);

ALTER TABLE `AutomationRun` DROP CHECK `AutomationRun_cause_arm_check`;
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_cause_arm_check` CHECK (
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
    )
);

ALTER TABLE `AutomationRun` DROP CHECK `AutomationRun_reply_handoff_arm_check`;
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_reply_handoff_arm_check` CHECK (
    `originKind` = 'direct' OR (
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
    )
);

-- Replace the input owner in place, admitting the accepted Workflow snapshot.
DROP TRIGGER `AutomationRun_execution_input_insert`;
DROP TRIGGER `AutomationRun_execution_input_update`;
CREATE TRIGGER `AutomationRun_execution_input_insert`
BEFORE INSERT ON `AutomationRun`
FOR EACH ROW
BEGIN
IF NOT (
    NEW.`state` NOT IN ('queued', 'claimed', 'running')
    OR NEW.`executionInputEnvelope` IS NOT NULL
    OR NEW.`workflowAcceptedSnapshotEnvelope` IS NOT NULL
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
    OR NEW.`workflowAcceptedSnapshotEnvelope` IS NOT NULL
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
