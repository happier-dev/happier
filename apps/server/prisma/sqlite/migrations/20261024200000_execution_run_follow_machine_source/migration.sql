-- Rebuild the two existing Follow adapters atomically, retaining all identity, policy and progress fields.
PRAGMA foreign_keys = ON;
CREATE TABLE "new_AccountSessionFollow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT,
    "sourceKey" TEXT,
    "sourceDiscussionId" TEXT,
    "sourceExecutionRunSessionId" TEXT,
    "sourceExecutionRunMachineId" TEXT,
    "sourceExecutionRunId" TEXT,
    "sourceWorkflowRunId" TEXT,
    "following" BOOLEAN NOT NULL DEFAULT true,
    "hasPersistentFollow" BOOLEAN NOT NULL DEFAULT true,
    "includeInVoice" BOOLEAN NOT NULL DEFAULT false,
    "voiceDeliveredFrontier" TEXT,
    "followPolicy" TEXT,
    "notifyOnce" TEXT,
    "deliveredDiscussionSeq" INTEGER,
    "deliveredExecutionRunTerminalEventId" TEXT,
    "deliveredWorkflowRunRevision" INTEGER,
    "deliveredExecutionRunPermissionKey" TEXT,
    CONSTRAINT "AccountSessionFollow_source_identity_check" CHECK (
        ("sessionId" IS NOT NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND ("sourceKey" IS NULL OR "sourceKey" = 'session:' || "sessionId")
            AND "deliveredDiscussionSeq" IS NULL AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NOT NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" IS NOT NULL AND "sourceKey" = 'discussion:' || "sourceDiscussionId"
            AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NULL AND (("sourceExecutionRunSessionId" IS NOT NULL AND "sourceExecutionRunMachineId" IS NULL) OR ("sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NOT NULL)) AND "sourceExecutionRunId" IS NOT NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" IS NOT NULL AND substr("sourceKey", 1, 14) = 'execution_run:'
            AND "deliveredDiscussionSeq" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NOT NULL
            AND "sourceKey" IS NOT NULL AND substr("sourceKey", 1, 13) = 'workflow_run:'
            AND "deliveredDiscussionSeq" IS NULL AND "deliveredExecutionRunTerminalEventId" IS NULL)
    ),
    CONSTRAINT "AccountSessionFollow_source_progress_check" CHECK (("deliveredDiscussionSeq" IS NULL OR "deliveredDiscussionSeq" >= 0)
        AND ("deliveredWorkflowRunRevision" IS NULL OR "deliveredWorkflowRunRevision" >= 0)),
    CONSTRAINT "AccountSessionFollow_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sourceDiscussionId_fkey" FOREIGN KEY ("sourceDiscussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sourceExecutionRunSessionId_fkey" FOREIGN KEY ("sourceExecutionRunSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sourceExecutionRunMachineId_fkey" FOREIGN KEY ("sourceExecutionRunMachineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountSessionFollow_sourceWorkflowRunId_fkey" FOREIGN KEY ("sourceWorkflowRunId") REFERENCES "AutomationRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AccountSessionFollow" (
    "id", "accountId", "sessionId", "sourceKey", "sourceDiscussionId", "sourceExecutionRunSessionId", "sourceExecutionRunId", "sourceWorkflowRunId",
    "following", "hasPersistentFollow", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce",
    "deliveredDiscussionSeq", "deliveredExecutionRunTerminalEventId", "deliveredWorkflowRunRevision", "deliveredExecutionRunPermissionKey"
)
SELECT "id", "accountId", "sessionId", "sourceKey", "sourceDiscussionId", "sourceExecutionRunSessionId", "sourceExecutionRunId", "sourceWorkflowRunId",
    "following", "hasPersistentFollow", "includeInVoice", "voiceDeliveredFrontier", "followPolicy", "notifyOnce",
    "deliveredDiscussionSeq", "deliveredExecutionRunTerminalEventId", "deliveredWorkflowRunRevision", "deliveredExecutionRunPermissionKey"
FROM "AccountSessionFollow";
DROP TABLE "AccountSessionFollow";
ALTER TABLE "new_AccountSessionFollow" RENAME TO "AccountSessionFollow";
CREATE UNIQUE INDEX "AccountSessionFollow_accountId_sessionId_key" ON "AccountSessionFollow" ("accountId", "sessionId");
CREATE UNIQUE INDEX "AccountSessionFollow_accountId_sourceKey_key" ON "AccountSessionFollow" ("accountId", "sourceKey");
CREATE INDEX "AccountSessionFollow_sessionId_idx" ON "AccountSessionFollow" ("sessionId");
CREATE INDEX "AccountSessionFollow_sourceDiscussionId_idx" ON "AccountSessionFollow" ("sourceDiscussionId");
CREATE INDEX "AccountSessionFollow_sourceExecutionRunSessionId_idx" ON "AccountSessionFollow" ("sourceExecutionRunSessionId");
CREATE INDEX "AccountSessionFollow_sourceWorkflowRunId_idx" ON "AccountSessionFollow" ("sourceWorkflowRunId");
CREATE INDEX "AccountSessionFollow_sourceExecutionRunMachineId_idx" ON "AccountSessionFollow" ("sourceExecutionRunMachineId");
CREATE TABLE "new_SessionFollowEdge" (
    "sourceKey" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "sourceDiscussionId" TEXT,
    "sourceExecutionRunSessionId" TEXT,
    "sourceExecutionRunMachineId" TEXT,
    "sourceExecutionRunId" TEXT,
    "sourceWorkflowRunId" TEXT,
    "destinationSessionId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'follower',
    "attachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "managerSourceSessionId" TEXT,
    "policyJson" TEXT NOT NULL,
    "deliveredTranscriptSeq" INTEGER NOT NULL DEFAULT 0,
    "deliveredReadyEventSeq" INTEGER NOT NULL DEFAULT 0,
    "deliveredAgentStateVersion" INTEGER NOT NULL DEFAULT 0,
    "deliveredTurnId" TEXT,
    "deliveredTurnStatus" TEXT,
    "deliveredExecutionRunTerminalEventId" TEXT,
    "deliveredWorkflowRunRevision" INTEGER,
    PRIMARY KEY ("destinationSessionId", "sourceKey", "relation"),
    CONSTRAINT "SessionFollowEdge_source_identity_check" CHECK (
        ("sourceSessionId" IS NOT NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" = 'session:' || "sourceSessionId" AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NOT NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" = 'discussion:' || "sourceDiscussionId" AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NULL AND (("sourceExecutionRunSessionId" IS NOT NULL AND "sourceExecutionRunMachineId" IS NULL) OR ("sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NOT NULL)) AND "sourceExecutionRunId" IS NOT NULL AND "sourceWorkflowRunId" IS NULL
            AND substr("sourceKey", 1, 14) = 'execution_run:' AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NOT NULL
            AND substr("sourceKey", 1, 13) = 'workflow_run:' AND "deliveredExecutionRunTerminalEventId" IS NULL)
    ),
    CONSTRAINT "SessionFollowEdge_manager_relation_check" CHECK (
        ("relation" = 'manager' AND "sourceSessionId" IS NOT NULL AND "managerSourceSessionId" IS NOT NULL AND "managerSourceSessionId" = "sourceSessionId")
        OR ("relation" = 'follower' AND "managerSourceSessionId" IS NULL)
    ),
    CONSTRAINT "SessionFollowEdge_deliveredTurn_pair_check" CHECK ("deliveredTurnStatus" IS NULL OR "deliveredTurnId" IS NOT NULL),
    CONSTRAINT "SessionFollowEdge_deliveredTurn_status_check" CHECK ("deliveredTurnStatus" IS NULL OR "deliveredTurnStatus" IN ('completed', 'failed', 'cancelled', 'waiting')),
    CONSTRAINT "SessionFollowEdge_distinct_sessions_check" CHECK ("sourceSessionId" <> "destinationSessionId"),
    CONSTRAINT "SessionFollowEdge_frontier_nonnegative_check" CHECK ("deliveredTranscriptSeq" >= 0 AND "deliveredReadyEventSeq" >= 0 AND "deliveredAgentStateVersion" >= 0
        AND ("deliveredWorkflowRunRevision" IS NULL OR "deliveredWorkflowRunRevision" >= 0)),
    CONSTRAINT "SessionFollowEdge_sourceSessionId_fkey" FOREIGN KEY ("sourceSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionFollowEdge_sourceDiscussionId_fkey" FOREIGN KEY ("sourceDiscussionId") REFERENCES "Discussion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionFollowEdge_sourceExecutionRunSessionId_fkey" FOREIGN KEY ("sourceExecutionRunSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionFollowEdge_sourceExecutionRunMachineId_fkey" FOREIGN KEY ("sourceExecutionRunMachineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionFollowEdge_sourceWorkflowRunId_fkey" FOREIGN KEY ("sourceWorkflowRunId") REFERENCES "AutomationRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionFollowEdge_destinationSessionId_fkey" FOREIGN KEY ("destinationSessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SessionFollowEdge" ("sourceKey", "sourceSessionId", "sourceDiscussionId", "sourceExecutionRunSessionId", "sourceExecutionRunId", "sourceWorkflowRunId", "destinationSessionId", "relation", "attachedAt", "managerSourceSessionId", "policyJson", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus", "deliveredExecutionRunTerminalEventId", "deliveredWorkflowRunRevision")
SELECT "sourceKey", "sourceSessionId", "sourceDiscussionId", "sourceExecutionRunSessionId", "sourceExecutionRunId", "sourceWorkflowRunId", "destinationSessionId", "relation", "attachedAt", "managerSourceSessionId", "policyJson", "deliveredTranscriptSeq", "deliveredReadyEventSeq", "deliveredAgentStateVersion", "deliveredTurnId", "deliveredTurnStatus", "deliveredExecutionRunTerminalEventId", "deliveredWorkflowRunRevision" FROM "SessionFollowEdge";
DROP TABLE "SessionFollowEdge";
ALTER TABLE "new_SessionFollowEdge" RENAME TO "SessionFollowEdge";
CREATE UNIQUE INDEX "SessionFollowEdge_session_source_relation_key" ON "SessionFollowEdge" ("destinationSessionId", "sourceSessionId", "relation");
CREATE UNIQUE INDEX "SessionFollowEdge_discussion_source_relation_key" ON "SessionFollowEdge" ("destinationSessionId", "sourceDiscussionId", "relation");
CREATE UNIQUE INDEX "SessionFollowEdge_managerSourceSessionId_key" ON "SessionFollowEdge" ("managerSourceSessionId");
CREATE INDEX "SessionFollowEdge_sourceSessionId_idx" ON "SessionFollowEdge" ("sourceSessionId");
CREATE INDEX "SessionFollowEdge_sourceDiscussionId_idx" ON "SessionFollowEdge" ("sourceDiscussionId");
CREATE INDEX "SessionFollowEdge_executionRunSource_idx" ON "SessionFollowEdge" ("sourceExecutionRunSessionId", "sourceExecutionRunId");
CREATE INDEX "SessionFollowEdge_sourceWorkflowRunId_idx" ON "SessionFollowEdge" ("sourceWorkflowRunId");
CREATE INDEX "SessionFollowEdge_executionRunMachineSource_idx" ON "SessionFollowEdge" ("sourceExecutionRunMachineId", "sourceExecutionRunId");
