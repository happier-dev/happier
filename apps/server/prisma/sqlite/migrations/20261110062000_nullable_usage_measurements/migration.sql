-- NULL means not measured. Existing measured values are preserved.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UsageEvent" (
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
    "idempotencyKey" TEXT,
    "turnId" TEXT,
    "executionRunId" TEXT,
    "teamCredentialResourceId" TEXT,
    "teamCredentialActorAccountId" TEXT,
    "teamCredentialExternalApiKeyId" TEXT,
    "teamCredentialSourceCredentialId" TEXT,
    "brokerMachineId" TEXT,
    "credentialDeliveryMode" TEXT,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "isCumulative" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "totalTokens" INTEGER,
    "reportedCostUsd" REAL,
    "estimatedCostUsd" REAL,
    "invoiceCostUsd" REAL,
    "billingContext" TEXT,
    "costSource" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "costBreakdown" TEXT,
    "contextUsedTokens" INTEGER,
    "contextWindowTokens" INTEGER,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UsageEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UsageEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_UsageEvent" ("accountId", "agentId", "backendMode", "billingContext", "brokerMachineId", "cacheReadTokens", "cacheWriteTokens", "contextUsedTokens", "contextWindowTokens", "costBreakdown", "costSource", "createdAt", "credentialDeliveryMode", "currency", "estimatedCostUsd", "executionRunId", "externalKey", "id", "idempotencyKey", "inputTokens", "invoiceCostUsd", "isCumulative", "machineId", "metadata", "modelId", "observedAt", "outputTokens", "projectKey", "reasoningTokens", "reportedCostUsd", "requestCount", "scope", "sessionId", "source", "teamCredentialActorAccountId", "teamCredentialExternalApiKeyId", "teamCredentialResourceId", "teamCredentialSourceCredentialId", "totalTokens", "turnId", "updatedAt", "workspaceId") SELECT "accountId", "agentId", "backendMode", "billingContext", "brokerMachineId", "cacheReadTokens", "cacheWriteTokens", "contextUsedTokens", "contextWindowTokens", "costBreakdown", "costSource", "createdAt", "credentialDeliveryMode", "currency", "estimatedCostUsd", "executionRunId", "externalKey", "id", "idempotencyKey", "inputTokens", "invoiceCostUsd", "isCumulative", "machineId", "metadata", "modelId", "observedAt", "outputTokens", "projectKey", "reasoningTokens", "reportedCostUsd", "requestCount", "scope", "sessionId", "source", "teamCredentialActorAccountId", "teamCredentialExternalApiKeyId", "teamCredentialResourceId", "teamCredentialSourceCredentialId", "totalTokens", "turnId", "updatedAt", "workspaceId" FROM "UsageEvent";
DROP TABLE "UsageEvent";
ALTER TABLE "new_UsageEvent" RENAME TO "UsageEvent";
CREATE UNIQUE INDEX "UsageEvent_idempotencyKey_key" ON "UsageEvent"("idempotencyKey");
CREATE INDEX "UsageEvent_accountId_observedAt_idx" ON "UsageEvent"("accountId", "observedAt");
CREATE INDEX "UsageEvent_sessionId_observedAt_idx" ON "UsageEvent"("sessionId", "observedAt");
CREATE INDEX "UsageEvent_accountId_agentId_observedAt_idx" ON "UsageEvent"("accountId", "agentId", "observedAt");
CREATE INDEX "UsageEvent_accountId_modelId_observedAt_idx" ON "UsageEvent"("accountId", "modelId", "observedAt");
CREATE INDEX "UsageEvent_accountId_projectKey_observedAt_idx" ON "UsageEvent"("accountId", "projectKey", "observedAt");
CREATE INDEX "UsageEvent_accountId_workspaceId_observedAt_idx" ON "UsageEvent"("accountId", "workspaceId", "observedAt");
CREATE INDEX "UsageEvent_accountId_source_observedAt_idx" ON "UsageEvent"("accountId", "source", "observedAt");
CREATE INDEX "UsageEvent_accountId_sessionId_source_externalKey_idx" ON "UsageEvent"("accountId", "sessionId", "source", "externalKey");
CREATE INDEX "UsageEvent_teamCredentialResourceId_observedAt_idx" ON "UsageEvent"("teamCredentialResourceId", "observedAt");
CREATE INDEX "UsageEvent_resource_actor_observed_idx" ON "UsageEvent"("teamCredentialResourceId", "teamCredentialActorAccountId", "observedAt");
CREATE INDEX "UsageEvent_teamCredentialExternalApiKeyId_observedAt_idx" ON "UsageEvent"("teamCredentialExternalApiKeyId", "observedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

