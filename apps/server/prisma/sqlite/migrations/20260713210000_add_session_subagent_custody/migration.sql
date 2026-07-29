CREATE TABLE "SessionSubagentCustody" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "custodyKey" TEXT NOT NULL,
    "subagentId" TEXT NOT NULL,
    "subagentKey" TEXT NOT NULL,
    "groupId" TEXT,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "content" JSONB NOT NULL,
    "terminalAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionSubagentCustody_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionSubagentCustody_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionSubagentCustodyReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "custodyKey" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "resultSubagentId" TEXT NOT NULL,
    "resultGroupId" TEXT,
    "resultStatus" TEXT NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "resultUpdatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSubagentCustodyReceipt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionSubagentCustodyReceipt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SubagentCustody_scope_subagent_key" ON "SessionSubagentCustody"("accountId", "sessionId", "custodyKey", "subagentKey");
CREATE INDEX "SessionSubagentCustody_scope_list_idx" ON "SessionSubagentCustody"("accountId", "sessionId", "custodyKey", "subagentKey");
CREATE INDEX "SessionSubagentCustody_sessionId_idx" ON "SessionSubagentCustody"("sessionId");
CREATE UNIQUE INDEX "SubagentCustodyReceipt_scope_operation_key" ON "SessionSubagentCustodyReceipt"("accountId", "sessionId", "custodyKey", "operationId");
CREATE INDEX "SessionSubagentCustodyReceipt_scope_expiry_idx" ON "SessionSubagentCustodyReceipt"("accountId", "sessionId", "custodyKey", "expiresAt");
CREATE INDEX "SessionSubagentCustodyReceipt_expiresAt_idx" ON "SessionSubagentCustodyReceipt"("expiresAt");
CREATE INDEX "SessionSubagentCustodyReceipt_sessionId_idx" ON "SessionSubagentCustodyReceipt"("sessionId");


ALTER TABLE "SessionSubagentCustody" ADD COLUMN "pluginId" TEXT NOT NULL DEFAULT '__legacy_unscoped__';
ALTER TABLE "SessionSubagentCustody" ADD COLUMN "contributionId" TEXT NOT NULL DEFAULT '__legacy_unscoped__';
ALTER TABLE "SessionSubagentCustody" ADD COLUMN "immutableGenerationId" TEXT NOT NULL DEFAULT '__legacy_unscoped__';
ALTER TABLE "SessionSubagentCustodyReceipt" ADD COLUMN "pluginId" TEXT NOT NULL DEFAULT '__legacy_unscoped__';
ALTER TABLE "SessionSubagentCustodyReceipt" ADD COLUMN "contributionId" TEXT NOT NULL DEFAULT '__legacy_unscoped__';
ALTER TABLE "SessionSubagentCustodyReceipt" ADD COLUMN "immutableGenerationId" TEXT NOT NULL DEFAULT '__legacy_unscoped__';

CREATE INDEX "SubagentCustody_generation_retirement_idx" ON "SessionSubagentCustody"("accountId", "pluginId", "immutableGenerationId");
CREATE INDEX "SubagentCustodyReceipt_generation_retirement_idx" ON "SessionSubagentCustodyReceipt"("accountId", "pluginId", "immutableGenerationId");

CREATE TABLE "SessionSubagentCustodyRetiredGeneration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "immutableGenerationId" TEXT NOT NULL,
    "capacitySlot" INTEGER NOT NULL,
    "retiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSubagentCustodyRetiredGeneration_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SubagentCustodyRetiredGeneration_key" ON "SessionSubagentCustodyRetiredGeneration"("accountId", "pluginId", "immutableGenerationId");
CREATE UNIQUE INDEX "SubagentCustodyRetiredGeneration_capacity_slot_key" ON "SessionSubagentCustodyRetiredGeneration"("accountId", "capacitySlot");
