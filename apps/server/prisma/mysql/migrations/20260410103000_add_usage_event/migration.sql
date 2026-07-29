CREATE TABLE `UsageEvent` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `observedAt` DATETIME(3) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `backendMode` VARCHAR(191) NULL,
    `modelId` VARCHAR(191) NULL,
    `projectKey` VARCHAR(191) NULL,
    `workspaceId` VARCHAR(191) NULL,
    `machineId` VARCHAR(191) NULL,
    `source` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `externalKey` VARCHAR(191) NULL,
    `turnId` VARCHAR(191) NULL,
    `isCumulative` BOOLEAN NOT NULL DEFAULT false,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `reasoningTokens` INTEGER NOT NULL DEFAULT 0,
    `cacheReadTokens` INTEGER NOT NULL DEFAULT 0,
    `cacheWriteTokens` INTEGER NOT NULL DEFAULT 0,
    `totalTokens` INTEGER NOT NULL DEFAULT 0,
    `reportedCostUsd` DOUBLE NOT NULL DEFAULT 0,
    `estimatedCostUsd` DOUBLE NOT NULL DEFAULT 0,
    `invoiceCostUsd` DOUBLE NOT NULL DEFAULT 0,
    `billingContext` VARCHAR(191) NULL,
    `costSource` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `costBreakdown` LONGTEXT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `contextUsedTokens` INTEGER NULL,
    `contextWindowTokens` INTEGER NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    INDEX `UsageEvent_accountId_observedAt_idx`(`accountId`, `observedAt`),
    INDEX `UsageEvent_sessionId_observedAt_idx`(`sessionId`, `observedAt`),
    INDEX `UsageEvent_accountId_agentId_observedAt_idx`(`accountId`, `agentId`, `observedAt`),
    INDEX `UsageEvent_accountId_modelId_observedAt_idx`(`accountId`, `modelId`, `observedAt`),
    INDEX `UsageEvent_accountId_projectKey_observedAt_idx`(`accountId`, `projectKey`, `observedAt`),
    INDEX `UsageEvent_accountId_workspaceId_observedAt_idx`(`accountId`, `workspaceId`, `observedAt`),
    INDEX `UsageEvent_accountId_source_observedAt_idx`(`accountId`, `source`, `observedAt`),
    INDEX `UsageEvent_accountId_sessionId_source_externalKey_idx`(`accountId`, `sessionId`, `source`, `externalKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UsageEvent`
ADD CONSTRAINT `UsageEvent_accountId_fkey`
FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `UsageEvent`
ADD CONSTRAINT `UsageEvent_sessionId_fkey`
FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX `UsageEvent_idempotencyKey_key` ON `UsageEvent`(`idempotencyKey`);
