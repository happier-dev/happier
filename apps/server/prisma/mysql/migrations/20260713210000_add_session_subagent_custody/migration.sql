CREATE TABLE `SessionSubagentCustody` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `custodyKey` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL,
    `subagentId` LONGTEXT NOT NULL,
    `subagentKey` CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
    `groupId` LONGTEXT NULL,
    `status` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `content` JSON NOT NULL,
    `terminalAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `SubagentCustody_scope_subagent_key`(`accountId`, `sessionId`, `custodyKey`, `subagentKey`),
    INDEX `SessionSubagentCustody_scope_list_idx`(`accountId`, `sessionId`, `custodyKey`, `subagentKey`),
    INDEX `SessionSubagentCustody_sessionId_idx`(`sessionId`),
    CONSTRAINT `SessionSubagentCustody_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `SessionSubagentCustody_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SessionSubagentCustodyReceipt` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `custodyKey` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL,
    `operationId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL,
    `requestDigest` VARCHAR(191) NOT NULL,
    `resultSubagentId` LONGTEXT NOT NULL,
    `resultGroupId` LONGTEXT NULL,
    `resultStatus` VARCHAR(191) NOT NULL,
    `resultRevision` INTEGER NOT NULL,
    `resultUpdatedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE INDEX `SubagentCustodyReceipt_scope_operation_key`(`accountId`, `sessionId`, `custodyKey`, `operationId`),
    INDEX `SessionSubagentCustodyReceipt_scope_expiry_idx`(`accountId`, `sessionId`, `custodyKey`, `expiresAt`),
    INDEX `SessionSubagentCustodyReceipt_expiresAt_idx`(`expiresAt`),
    INDEX `SessionSubagentCustodyReceipt_sessionId_idx`(`sessionId`),
    CONSTRAINT `SessionSubagentCustodyReceipt_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `SessionSubagentCustodyReceipt_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


ALTER TABLE `SessionSubagentCustody`
    ADD COLUMN `pluginId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '__legacy_unscoped__',
    ADD COLUMN `contributionId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '__legacy_unscoped__',
    ADD COLUMN `immutableGenerationId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '__legacy_unscoped__';

ALTER TABLE `SessionSubagentCustody`
    ALTER COLUMN `pluginId` DROP DEFAULT,
    ALTER COLUMN `contributionId` DROP DEFAULT,
    ALTER COLUMN `immutableGenerationId` DROP DEFAULT;

ALTER TABLE `SessionSubagentCustodyReceipt`
    ADD COLUMN `pluginId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '__legacy_unscoped__',
    ADD COLUMN `contributionId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '__legacy_unscoped__',
    ADD COLUMN `immutableGenerationId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '__legacy_unscoped__';

ALTER TABLE `SessionSubagentCustodyReceipt`
    ALTER COLUMN `pluginId` DROP DEFAULT,
    ALTER COLUMN `contributionId` DROP DEFAULT,
    ALTER COLUMN `immutableGenerationId` DROP DEFAULT;

CREATE INDEX `SubagentCustody_generation_retirement_idx` ON `SessionSubagentCustody`(`accountId`, `pluginId`, `immutableGenerationId`);
CREATE INDEX `SubagentCustodyReceipt_generation_retirement_idx` ON `SessionSubagentCustodyReceipt`(`accountId`, `pluginId`, `immutableGenerationId`);

CREATE TABLE `SessionSubagentCustodyRetiredGeneration` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `pluginId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL,
    `immutableGenerationId` VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL,
    `capacitySlot` INTEGER NOT NULL,
    `retiredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE INDEX `SubagentCustodyRetiredGeneration_key`(`accountId`, `pluginId`, `immutableGenerationId`),
    UNIQUE INDEX `SubagentCustodyRetiredGeneration_capacity_slot_key`(`accountId`, `capacitySlot`),
    CONSTRAINT `SessionSubagentCustodyRetiredGeneration_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
