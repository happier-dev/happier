-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleKind" TEXT NOT NULL,
    "scheduleExpr" TEXT,
    "everyMs" INTEGER,
    "timezone" TEXT,
    "targetType" TEXT NOT NULL,
    "templateCiphertext" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Automation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutomationAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "automationId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutomationAssignment_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationAssignment_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "automationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "scheduledAt" DATETIME NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "claimedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "claimedByMachineId" TEXT,
    "leaseExpiresAt" DATETIME,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "summaryCiphertext" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "producedSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_claimedByMachineId_fkey" FOREIGN KEY ("claimedByMachineId") REFERENCES "Machine" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRun_producedSessionId_fkey" FOREIGN KEY ("producedSessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutomationRunEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "payload" TEXT,
    CONSTRAINT "AutomationRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Automation_accountId_enabled_updatedAt_idx" ON "Automation"("accountId", "enabled", "updatedAt");

-- CreateIndex
CREATE INDEX "Automation_accountId_nextRunAt_idx" ON "Automation"("accountId", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationAssignment_automationId_machineId_key" ON "AutomationAssignment"("automationId", "machineId");

-- CreateIndex
CREATE INDEX "AutomationAssignment_machineId_enabled_idx" ON "AutomationAssignment"("machineId", "enabled");

-- CreateIndex
CREATE INDEX "AutomationAssignment_automationId_enabled_idx" ON "AutomationAssignment"("automationId", "enabled");

-- CreateIndex
CREATE INDEX "AutomationRun_accountId_state_dueAt_idx" ON "AutomationRun"("accountId", "state", "dueAt");

-- CreateIndex
CREATE INDEX "AutomationRun_automationId_dueAt_idx" ON "AutomationRun"("automationId", "dueAt");

-- CreateIndex
CREATE INDEX "AutomationRun_claimedByMachineId_leaseExpiresAt_idx" ON "AutomationRun"("claimedByMachineId", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "AutomationRunEvent_runId_ts_idx" ON "AutomationRunEvent"("runId", "ts");
