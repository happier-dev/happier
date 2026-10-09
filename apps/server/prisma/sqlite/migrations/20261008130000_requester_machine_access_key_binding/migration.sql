-- Rebuild only the FK-bearing table; copy every tuple, byte, version and time.
CREATE TABLE "new_AccessKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "dataVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccessKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AccessKey_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AccessKey_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AccessKey" ("id", "accountId", "machineId", "sessionId", "data", "dataVersion", "createdAt", "updatedAt")
    SELECT "id", "accountId", "machineId", "sessionId", "data", "dataVersion", "createdAt", "updatedAt" FROM "AccessKey";
DROP TABLE "AccessKey";
ALTER TABLE "new_AccessKey" RENAME TO "AccessKey";
CREATE UNIQUE INDEX "AccessKey_accountId_machineId_sessionId_key" ON "AccessKey"("accountId", "machineId", "sessionId");
CREATE INDEX "AccessKey_accountId_idx" ON "AccessKey"("accountId");
CREATE INDEX "AccessKey_sessionId_idx" ON "AccessKey"("sessionId");
CREATE INDEX "AccessKey_machineId_idx" ON "AccessKey"("machineId");
