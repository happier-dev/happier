-- CreateTable
CREATE TABLE "SessionAppearance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "displayDbValue" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionAppearance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionAppearance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionAppearance_sessionId_idx" ON "SessionAppearance"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionAppearance_accountId_sessionId_key" ON "SessionAppearance"("accountId", "sessionId");
