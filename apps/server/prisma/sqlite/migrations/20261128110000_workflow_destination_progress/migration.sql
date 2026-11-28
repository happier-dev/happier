CREATE TABLE "WorkflowRunDestination" (
    "rootRecordId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "contentEnvelope" TEXT NOT NULL,
    PRIMARY KEY ("rootRecordId", "ordinal"),
    CONSTRAINT "WorkflowRunDestination_rootRecordId_fkey" FOREIGN KEY ("rootRecordId") REFERENCES "WorkflowRunInvocation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
