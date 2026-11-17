CREATE TABLE "ProjectSourceSessionDefaults" (
    "sourceId" TEXT NOT NULL PRIMARY KEY,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "defaults" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectSourceSessionDefaults_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ProjectSource"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
