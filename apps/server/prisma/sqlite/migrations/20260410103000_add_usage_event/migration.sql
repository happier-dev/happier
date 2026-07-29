CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "observedAt" DATETIME NOT NULL,
    "agentId" TEXT NOT NULL,
    "backendMode" TEXT,
    "modelId" TEXT,
    "projectKey" TEXT,
    "workspaceId" TEXT,
    "machineId" TEXT,
    "source" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "externalKey" TEXT,
    "turnId" TEXT,
    "isCumulative" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "reportedCostUsd" REAL NOT NULL DEFAULT 0,
    "estimatedCostUsd" REAL NOT NULL DEFAULT 0,
    "invoiceCostUsd" REAL NOT NULL DEFAULT 0,
    "billingContext" TEXT,
    "costSource" TEXT,
    "idempotencyKey" TEXT,
    "costBreakdown" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "contextUsedTokens" INTEGER,
    "contextWindowTokens" INTEGER,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UsageEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UsageEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "UsageEvent_accountId_observedAt_idx" ON "UsageEvent"("accountId", "observedAt");
CREATE INDEX "UsageEvent_sessionId_observedAt_idx" ON "UsageEvent"("sessionId", "observedAt");
CREATE INDEX "UsageEvent_accountId_agentId_observedAt_idx" ON "UsageEvent"("accountId", "agentId", "observedAt");
CREATE INDEX "UsageEvent_accountId_modelId_observedAt_idx" ON "UsageEvent"("accountId", "modelId", "observedAt");
CREATE INDEX "UsageEvent_accountId_projectKey_observedAt_idx" ON "UsageEvent"("accountId", "projectKey", "observedAt");
CREATE INDEX "UsageEvent_accountId_workspaceId_observedAt_idx" ON "UsageEvent"("accountId", "workspaceId", "observedAt");
CREATE INDEX "UsageEvent_accountId_source_observedAt_idx" ON "UsageEvent"("accountId", "source", "observedAt");
CREATE INDEX "UsageEvent_accountId_sessionId_source_externalKey_idx" ON "UsageEvent"("accountId", "sessionId", "source", "externalKey");

CREATE UNIQUE INDEX "UsageEvent_idempotencyKey_key" ON "UsageEvent"("idempotencyKey");
