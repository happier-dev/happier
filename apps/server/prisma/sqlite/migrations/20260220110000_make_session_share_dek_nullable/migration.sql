-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_SessionShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sharedByUserId" TEXT NOT NULL,
    "sharedWithUserId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL DEFAULT 'view',
    "canApprovePermissions" BOOLEAN NOT NULL DEFAULT false,
    "encryptedDataKey" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionShare_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionShare_sharedByUserId_fkey" FOREIGN KEY ("sharedByUserId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SessionShare_sharedWithUserId_fkey" FOREIGN KEY ("sharedWithUserId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_SessionShare" ("accessLevel", "canApprovePermissions", "createdAt", "encryptedDataKey", "id", "sessionId", "sharedByUserId", "sharedWithUserId", "updatedAt")
SELECT "accessLevel", "canApprovePermissions", "createdAt", "encryptedDataKey", "id", "sessionId", "sharedByUserId", "sharedWithUserId", "updatedAt" FROM "SessionShare";

DROP TABLE "SessionShare";
ALTER TABLE "new_SessionShare" RENAME TO "SessionShare";

CREATE INDEX "SessionShare_sharedWithUserId_idx" ON "SessionShare"("sharedWithUserId");
CREATE INDEX "SessionShare_sharedByUserId_idx" ON "SessionShare"("sharedByUserId");
CREATE INDEX "SessionShare_sessionId_idx" ON "SessionShare"("sessionId");
CREATE UNIQUE INDEX "SessionShare_sessionId_sharedWithUserId_key" ON "SessionShare"("sessionId", "sharedWithUserId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

