-- Account-scoped Automation policy remains server-readable while private
-- Account settings may be E2EE. These constant defaults backfill existing rows.
ALTER TABLE `Account`
    ADD COLUMN `automationMaxActiveRunsPerMachine` INTEGER NOT NULL DEFAULT 4,
    ADD COLUMN `automationRunRetention` VARCHAR(191) NOT NULL DEFAULT 'thirtyDays';

-- A non-null timestamp is the bounded user-readable fact that private Run
-- content was compacted while the lifecycle row remains retained.
ALTER TABLE `AutomationRun`
    ADD COLUMN `contentRemovedAt` DATETIME(3) NULL;

-- Retention compaction clears private reply payloads only after the owner has
-- marked the Run. The active Conversation arm remains strict; the compacted
-- arm retains the handoff identity while requiring both payload envelopes to
-- be absent.
ALTER TABLE `AutomationRun`
    DROP CHECK `AutomationRun_reply_handoff_arm_check`;

ALTER TABLE `AutomationRun`
    ADD CONSTRAINT `AutomationRun_reply_handoff_arm_check`
    CHECK (
        (
            `originKind` = 'conversation'
            AND `contentRemovedAt` IS NULL
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
            `originKind` = 'conversation'
            AND `contentRemovedAt` IS NOT NULL
            AND `replyContextEnvelope` IS NULL
            AND `replyHandoffActionPluginId` IS NOT NULL
            AND `replyHandoffActionLocalId` IS NOT NULL
            AND `replyHandoffTargetMachineId` IS NOT NULL
            AND `replyHandoffTargetMachineInstallationId` IS NOT NULL
            AND `replyHandoffTargetMaterializationId` IS NOT NULL
            AND `replyHandoffId` IS NOT NULL
            AND `replyHandoffState` <> 'none'
            AND `replyHandoffReceiptEnvelope` IS NULL
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
