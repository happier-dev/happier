-- CreateTable
CREATE TABLE `Automation` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `scheduleKind` ENUM('cron', 'interval') NOT NULL,
    `scheduleExpr` TEXT NULL,
    `everyMs` INTEGER NULL,
    `timezone` VARCHAR(191) NULL,
    `targetType` ENUM('new_session', 'existing_session') NOT NULL,
    `templateCiphertext` LONGTEXT NOT NULL,
    `templateVersion` INTEGER NOT NULL DEFAULT 0,
    `nextRunAt` DATETIME(3) NULL,
    `lastRunAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Automation_accountId_enabled_updatedAt_idx`(`accountId`, `enabled`, `updatedAt`),
    INDEX `Automation_accountId_nextRunAt_idx`(`accountId`, `nextRunAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AutomationAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `automationId` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AutomationAssignment_automationId_machineId_key`(`automationId`, `machineId`),
    INDEX `AutomationAssignment_machineId_enabled_idx`(`machineId`, `enabled`),
    INDEX `AutomationAssignment_automationId_enabled_idx`(`automationId`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AutomationRun` (
    `id` VARCHAR(191) NOT NULL,
    `automationId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `state` ENUM('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired') NOT NULL DEFAULT 'queued',
    `scheduledAt` DATETIME(3) NOT NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `claimedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `claimedByMachineId` VARCHAR(191) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `summaryCiphertext` LONGTEXT NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `producedSessionId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AutomationRun_accountId_state_dueAt_idx`(`accountId`, `state`, `dueAt`),
    INDEX `AutomationRun_automationId_dueAt_idx`(`automationId`, `dueAt`),
    INDEX `AutomationRun_claimedByMachineId_leaseExpiresAt_idx`(`claimedByMachineId`, `leaseExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AutomationRunEvent` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `ts` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `type` VARCHAR(191) NOT NULL,
    `payload` JSON NULL,

    INDEX `AutomationRunEvent_runId_ts_idx`(`runId`, `ts`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Automation` ADD CONSTRAINT `Automation_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationAssignment` ADD CONSTRAINT `AutomationAssignment_automationId_fkey` FOREIGN KEY (`automationId`) REFERENCES `Automation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationAssignment` ADD CONSTRAINT `AutomationAssignment_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_automationId_fkey` FOREIGN KEY (`automationId`) REFERENCES `Automation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_claimedByMachineId_fkey` FOREIGN KEY (`claimedByMachineId`) REFERENCES `Machine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationRun` ADD CONSTRAINT `AutomationRun_producedSessionId_fkey` FOREIGN KEY (`producedSessionId`) REFERENCES `Session`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationRunEvent` ADD CONSTRAINT `AutomationRunEvent_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `AutomationRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
