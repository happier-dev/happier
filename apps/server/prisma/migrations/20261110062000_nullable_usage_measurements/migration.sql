-- NULL means not measured. Existing measured values are preserved.
-- AlterTable
ALTER TABLE "UsageEvent" ALTER COLUMN "inputTokens" DROP NOT NULL,
ALTER COLUMN "inputTokens" DROP DEFAULT,
ALTER COLUMN "outputTokens" DROP NOT NULL,
ALTER COLUMN "outputTokens" DROP DEFAULT,
ALTER COLUMN "reasoningTokens" DROP NOT NULL,
ALTER COLUMN "reasoningTokens" DROP DEFAULT,
ALTER COLUMN "cacheReadTokens" DROP NOT NULL,
ALTER COLUMN "cacheReadTokens" DROP DEFAULT,
ALTER COLUMN "cacheWriteTokens" DROP NOT NULL,
ALTER COLUMN "cacheWriteTokens" DROP DEFAULT,
ALTER COLUMN "totalTokens" DROP NOT NULL,
ALTER COLUMN "totalTokens" DROP DEFAULT,
ALTER COLUMN "reportedCostUsd" DROP NOT NULL,
ALTER COLUMN "reportedCostUsd" DROP DEFAULT,
ALTER COLUMN "estimatedCostUsd" DROP NOT NULL,
ALTER COLUMN "estimatedCostUsd" DROP DEFAULT,
ALTER COLUMN "invoiceCostUsd" DROP NOT NULL,
ALTER COLUMN "invoiceCostUsd" DROP DEFAULT;

