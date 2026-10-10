CREATE TABLE "ProjectSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdByAccountId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "repository" JSONB NOT NULL,
    "defaultRef" TEXT,
    "subdir" TEXT,
    "audience" JSONB NOT NULL,
    "attachments" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectSource_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectSource_createdByAccountId_id_idx" ON "ProjectSource"("createdByAccountId", "id");
