CREATE TABLE "ReviewMetadata" (
    "artifactId" TEXT NOT NULL PRIMARY KEY,
    "projectSourceId" TEXT,
    "workflowId" TEXT,
    "subjectKind" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "currentRoundOrdinal" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "ReviewMetadata_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ReviewMetadata_projectSourceId_state_artifactId_idx" ON "ReviewMetadata"("projectSourceId", "state", "artifactId");
CREATE INDEX "ReviewMetadata_workflowId_startedAt_artifactId_idx" ON "ReviewMetadata"("workflowId", "startedAt" DESC, "artifactId");
CREATE INDEX "ReviewMetadata_state_startedAt_artifactId_idx" ON "ReviewMetadata"("state", "startedAt" DESC, "artifactId");
