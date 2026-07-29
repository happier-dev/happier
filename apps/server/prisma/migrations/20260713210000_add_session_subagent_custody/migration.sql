CREATE TABLE "SessionSubagentCustody" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "custodyKey" TEXT COLLATE "C" NOT NULL,
    "subagentId" TEXT NOT NULL,
    "subagentKey" TEXT COLLATE "C" NOT NULL,
    "groupId" TEXT,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "content" JSONB NOT NULL,
    "terminalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SessionSubagentCustody_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SessionSubagentCustodyReceipt" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "custodyKey" TEXT COLLATE "C" NOT NULL,
    "operationId" TEXT COLLATE "C" NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "resultSubagentId" TEXT NOT NULL,
    "resultGroupId" TEXT,
    "resultStatus" TEXT NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "resultUpdatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSubagentCustodyReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubagentCustody_scope_subagent_key" ON "SessionSubagentCustody"("accountId", "sessionId", "custodyKey", "subagentKey");
CREATE INDEX "SessionSubagentCustody_scope_list_idx" ON "SessionSubagentCustody"("accountId", "sessionId", "custodyKey", "subagentKey");
CREATE INDEX "SessionSubagentCustody_sessionId_idx" ON "SessionSubagentCustody"("sessionId");
CREATE UNIQUE INDEX "SubagentCustodyReceipt_scope_operation_key" ON "SessionSubagentCustodyReceipt"("accountId", "sessionId", "custodyKey", "operationId");
CREATE INDEX "SessionSubagentCustodyReceipt_scope_expiry_idx" ON "SessionSubagentCustodyReceipt"("accountId", "sessionId", "custodyKey", "expiresAt");
CREATE INDEX "SessionSubagentCustodyReceipt_expiresAt_idx" ON "SessionSubagentCustodyReceipt"("expiresAt");
CREATE INDEX "SessionSubagentCustodyReceipt_sessionId_idx" ON "SessionSubagentCustodyReceipt"("sessionId");

ALTER TABLE "SessionSubagentCustody" ADD CONSTRAINT "SessionSubagentCustody_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionSubagentCustody" ADD CONSTRAINT "SessionSubagentCustody_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionSubagentCustodyReceipt" ADD CONSTRAINT "SessionSubagentCustodyReceipt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionSubagentCustodyReceipt" ADD CONSTRAINT "SessionSubagentCustodyReceipt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "SessionSubagentCustody"
    ADD COLUMN "pluginId" TEXT COLLATE "C" NOT NULL DEFAULT '__legacy_unscoped__',
    ADD COLUMN "contributionId" TEXT COLLATE "C" NOT NULL DEFAULT '__legacy_unscoped__',
    ADD COLUMN "immutableGenerationId" TEXT COLLATE "C" NOT NULL DEFAULT '__legacy_unscoped__';

ALTER TABLE "SessionSubagentCustody"
    ALTER COLUMN "pluginId" DROP DEFAULT,
    ALTER COLUMN "contributionId" DROP DEFAULT,
    ALTER COLUMN "immutableGenerationId" DROP DEFAULT;

ALTER TABLE "SessionSubagentCustodyReceipt"
    ADD COLUMN "pluginId" TEXT COLLATE "C" NOT NULL DEFAULT '__legacy_unscoped__',
    ADD COLUMN "contributionId" TEXT COLLATE "C" NOT NULL DEFAULT '__legacy_unscoped__',
    ADD COLUMN "immutableGenerationId" TEXT COLLATE "C" NOT NULL DEFAULT '__legacy_unscoped__';

ALTER TABLE "SessionSubagentCustodyReceipt"
    ALTER COLUMN "pluginId" DROP DEFAULT,
    ALTER COLUMN "contributionId" DROP DEFAULT,
    ALTER COLUMN "immutableGenerationId" DROP DEFAULT;

CREATE INDEX "SubagentCustody_generation_retirement_idx" ON "SessionSubagentCustody"("accountId", "pluginId", "immutableGenerationId");
CREATE INDEX "SubagentCustodyReceipt_generation_retirement_idx" ON "SessionSubagentCustodyReceipt"("accountId", "pluginId", "immutableGenerationId");

CREATE TABLE "SessionSubagentCustodyRetiredGeneration" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pluginId" TEXT COLLATE "C" NOT NULL,
    "immutableGenerationId" TEXT COLLATE "C" NOT NULL,
    "capacitySlot" INTEGER NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSubagentCustodyRetiredGeneration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubagentCustodyRetiredGeneration_key" ON "SessionSubagentCustodyRetiredGeneration"("accountId", "pluginId", "immutableGenerationId");
CREATE UNIQUE INDEX "SubagentCustodyRetiredGeneration_capacity_slot_key" ON "SessionSubagentCustodyRetiredGeneration"("accountId", "capacitySlot");

ALTER TABLE "SessionSubagentCustodyRetiredGeneration" ADD CONSTRAINT "SessionSubagentCustodyRetiredGeneration_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
