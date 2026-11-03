PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ProjectSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdByAccountId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "repository" JSONB,
    "owner" JSONB,
    "defaultRef" TEXT,
    "subdir" TEXT,
    "audience" JSONB NOT NULL,
    "attachments" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectSource_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ProjectSource" ("id", "createdByAccountId", "revision", "name", "repository", "owner", "defaultRef", "subdir", "audience", "attachments", "createdAt", "updatedAt")
SELECT "id", "createdByAccountId", "revision", "name", "repository", "owner", "defaultRef", "subdir", "audience", "attachments", "createdAt", "updatedAt" FROM "ProjectSource";

DROP TABLE "ProjectSource";
ALTER TABLE "new_ProjectSource" RENAME TO "ProjectSource";
CREATE INDEX "ProjectSource_createdByAccountId_id_idx" ON "ProjectSource"("createdByAccountId", "id");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
