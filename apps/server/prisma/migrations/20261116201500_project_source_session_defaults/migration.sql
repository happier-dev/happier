CREATE TABLE "ProjectSourceSessionDefaults" (
    "sourceId" TEXT NOT NULL PRIMARY KEY,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "defaults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectSourceSessionDefaults_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ProjectSource"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Scoped Source reads use containment against admitted principals, outside deleted Sources.
CREATE INDEX "ProjectSource_owner_live_gin" ON "ProjectSource" USING GIN ("owner" jsonb_path_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX "ProjectSource_audience_live_gin" ON "ProjectSource" USING GIN ("audience" jsonb_path_ops) WHERE "deletedAt" IS NULL;
