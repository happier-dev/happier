-- CreateEnum
CREATE TYPE "AutomationScheduleKind" AS ENUM ('cron', 'interval');

-- CreateEnum
CREATE TYPE "AutomationTargetType" AS ENUM ('new_session', 'existing_session');

-- CreateEnum
CREATE TYPE "AutomationRunState" AS ENUM ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleKind" "AutomationScheduleKind" NOT NULL,
    "scheduleExpr" TEXT,
    "everyMs" INTEGER,
    "timezone" TEXT,
    "targetType" "AutomationTargetType" NOT NULL,
    "templateCiphertext" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationAssignment" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "state" "AutomationRunState" NOT NULL DEFAULT 'queued',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "claimedByMachineId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "summaryCiphertext" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "producedSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "payload" JSONB,

    CONSTRAINT "AutomationRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Automation_accountId_enabled_updatedAt_idx" ON "Automation"("accountId", "enabled", "updatedAt" DESC);

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

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAssignment" ADD CONSTRAINT "AutomationAssignment_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationAssignment" ADD CONSTRAINT "AutomationAssignment_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_claimedByMachineId_fkey" FOREIGN KEY ("claimedByMachineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_producedSessionId_fkey" FOREIGN KEY ("producedSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunEvent" ADD CONSTRAINT "AutomationRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
