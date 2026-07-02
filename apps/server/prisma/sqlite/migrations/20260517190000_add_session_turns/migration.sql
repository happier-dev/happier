-- AlterTable
ALTER TABLE "Session" ADD COLUMN "latestTurnStatusObservedAt" BIGINT;
ALTER TABLE "Session" ADD COLUMN "latestTurnId" TEXT;

CREATE TABLE "SessionTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "provider" TEXT,
    "providerTurnId" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "terminalAt" BIGINT,
    "lastRuntimeIssueJson" TEXT,
    "transcriptAnchorsJson" TEXT,
    "rollbackState" TEXT,
    "rollbackReason" TEXT,
    "providerRollbackOrdinal" INTEGER,
    "rollbackUpdatedAt" BIGINT,
    "lastMutationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionTurnMutationReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "turnId" TEXT,
    "action" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "observedAt" BIGINT NOT NULL,
    "appliedAt" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionTurnMutationReceipt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SessionTurn_sessionId_turnId_key"
ON "SessionTurn"("sessionId", "turnId");

CREATE INDEX "SessionTurn_sessionId_updatedAt_idx"
ON "SessionTurn"("sessionId", "updatedAt");

CREATE INDEX "SessionTurn_sessionId_status_idx"
ON "SessionTurn"("sessionId", "status");

CREATE INDEX "SessionTurn_sessionId_rollbackState_idx"
ON "SessionTurn"("sessionId", "rollbackState");

CREATE INDEX "SessionTurn_sessionId_provider_providerTurnId_idx"
ON "SessionTurn"("sessionId", "provider", "providerTurnId");

CREATE UNIQUE INDEX "SessionTurnMutationReceipt_sessionId_mutationId_key"
ON "SessionTurnMutationReceipt"("sessionId", "mutationId");

CREATE INDEX "SessionTurnMutationReceipt_sessionId_appliedAt_idx"
ON "SessionTurnMutationReceipt"("sessionId", "appliedAt");
