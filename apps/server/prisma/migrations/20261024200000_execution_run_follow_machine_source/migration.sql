-- Add Machine custody to the existing execution_run source; preserve every existing Follow key and frontier.
BEGIN;
ALTER TABLE "AccountSessionFollow"
    ADD COLUMN "sourceExecutionRunMachineId" TEXT,
    DROP CONSTRAINT "AccountSessionFollow_source_identity_check",
    ADD CONSTRAINT "AccountSessionFollow_source_identity_check" CHECK (
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
    ADD CONSTRAINT "AccountSessionFollow_sourceExecutionRunMachineId_fkey" FOREIGN KEY ("sourceExecutionRunMachineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AccountSessionFollow_sourceExecutionRunMachineId_idx" ON "AccountSessionFollow" ("sourceExecutionRunMachineId");
ALTER TABLE "SessionFollowEdge"
    ADD COLUMN "sourceExecutionRunMachineId" TEXT,
    DROP CONSTRAINT "SessionFollowEdge_source_identity_check",
    ADD CONSTRAINT "SessionFollowEdge_source_identity_check" CHECK (
        ("sourceSessionId" IS NOT NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" = 'session:' || "sourceSessionId" AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NOT NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NULL
            AND "sourceKey" = 'discussion:' || "sourceDiscussionId" AND "deliveredExecutionRunTerminalEventId" IS NULL AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NULL AND (("sourceExecutionRunSessionId" IS NOT NULL AND "sourceExecutionRunMachineId" IS NULL) OR ("sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NOT NULL)) AND "sourceExecutionRunId" IS NOT NULL AND "sourceWorkflowRunId" IS NULL
            AND substr("sourceKey", 1, 14) = 'execution_run:' AND "deliveredWorkflowRunRevision" IS NULL)
        OR ("sourceSessionId" IS NULL AND "sourceDiscussionId" IS NULL AND "sourceExecutionRunSessionId" IS NULL AND "sourceExecutionRunMachineId" IS NULL AND "sourceExecutionRunId" IS NULL AND "sourceWorkflowRunId" IS NOT NULL
            AND substr("sourceKey", 1, 13) = 'workflow_run:' AND "deliveredExecutionRunTerminalEventId" IS NULL)
    ),
    ADD CONSTRAINT "SessionFollowEdge_sourceExecutionRunMachineId_fkey" FOREIGN KEY ("sourceExecutionRunMachineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SessionFollowEdge_executionRunMachineSource_idx" ON "SessionFollowEdge" ("sourceExecutionRunMachineId", "sourceExecutionRunId");
COMMIT;
