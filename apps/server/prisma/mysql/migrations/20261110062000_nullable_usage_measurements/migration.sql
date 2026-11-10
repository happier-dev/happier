-- NULL means not measured. Existing measured values are preserved.
-- AlterTable
ALTER TABLE `UsageEvent` MODIFY `inputTokens` INTEGER NULL,
    MODIFY `outputTokens` INTEGER NULL,
    MODIFY `reasoningTokens` INTEGER NULL,
    MODIFY `cacheReadTokens` INTEGER NULL,
    MODIFY `cacheWriteTokens` INTEGER NULL,
    MODIFY `totalTokens` INTEGER NULL,
    MODIFY `reportedCostUsd` DOUBLE NULL,
    MODIFY `estimatedCostUsd` DOUBLE NULL,
    MODIFY `invoiceCostUsd` DOUBLE NULL;

