-- AlterTable
ALTER TABLE `Session` ADD COLUMN `latestTurnStatusObservedAt` BIGINT NULL,
    ADD COLUMN `latestTurnId` VARCHAR(191) NULL;

CREATE TABLE `SessionTurn` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `turnId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NULL,
    `providerTurnId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `startedAt` BIGINT NOT NULL,
    `updatedAt` BIGINT NOT NULL,
    `terminalAt` BIGINT NULL,
    `lastRuntimeIssueJson` LONGTEXT NULL,
    `transcriptAnchorsJson` LONGTEXT NULL,
    `rollbackState` VARCHAR(191) NULL,
    `rollbackReason` VARCHAR(191) NULL,
    `providerRollbackOrdinal` INTEGER NULL,
    `rollbackUpdatedAt` BIGINT NULL,
    `lastMutationId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
);

CREATE TABLE `SessionTurnMutationReceipt` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `mutationId` VARCHAR(191) NOT NULL,
    `turnId` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `decision` VARCHAR(191) NOT NULL,
    `observedAt` BIGINT NOT NULL,
    `appliedAt` BIGINT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
);

CREATE UNIQUE INDEX `SessionTurn_sessionId_turnId_key`
ON `SessionTurn`(`sessionId`, `turnId`);

CREATE INDEX `SessionTurn_sessionId_updatedAt_idx`
ON `SessionTurn`(`sessionId`, `updatedAt`);

CREATE INDEX `SessionTurn_sessionId_status_idx`
ON `SessionTurn`(`sessionId`, `status`);

CREATE INDEX `SessionTurn_sessionId_rollbackState_idx`
ON `SessionTurn`(`sessionId`, `rollbackState`);

CREATE INDEX `SessionTurn_sessionId_provider_providerTurnId_idx`
ON `SessionTurn`(`sessionId`, `provider`, `providerTurnId`);

CREATE UNIQUE INDEX `SessionTurnMutationReceipt_sessionId_mutationId_key`
ON `SessionTurnMutationReceipt`(`sessionId`, `mutationId`);

CREATE INDEX `SessionTurnMutationReceipt_sessionId_appliedAt_idx`
ON `SessionTurnMutationReceipt`(`sessionId`, `appliedAt`);

ALTER TABLE `SessionTurn` ADD CONSTRAINT `SessionTurn_sessionId_fkey`
FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionTurnMutationReceipt` ADD CONSTRAINT `SessionTurnMutationReceipt_sessionId_fkey`
FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
