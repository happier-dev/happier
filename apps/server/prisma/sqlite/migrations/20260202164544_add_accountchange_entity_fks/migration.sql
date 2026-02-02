-- CreateTable
CREATE TABLE "AccountChange" (
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "cursor" INTEGER NOT NULL,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hint" JSONB,
    "sessionId" TEXT,
    "machineId" TEXT,
    "artifactId" TEXT,

    PRIMARY KEY ("accountId", "kind", "entityId"),
    CONSTRAINT "AccountChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AccountChange_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AccountChange_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AccountChange_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "contentPublicKey" BLOB,
    "contentPublicKeySig" BLOB,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "changesFloor" INTEGER NOT NULL DEFAULT 0,
    "feedSeq" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "settings" TEXT,
    "settingsVersion" INTEGER NOT NULL DEFAULT 0,
    "githubUserId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "avatar" JSONB,
    CONSTRAINT "Account_githubUserId_fkey" FOREIGN KEY ("githubUserId") REFERENCES "GithubUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Account" ("avatar", "contentPublicKey", "contentPublicKeySig", "createdAt", "feedSeq", "firstName", "githubUserId", "id", "lastName", "publicKey", "seq", "settings", "settingsVersion", "updatedAt", "username") SELECT "avatar", "contentPublicKey", "contentPublicKeySig", "createdAt", "feedSeq", "firstName", "githubUserId", "id", "lastName", "publicKey", "seq", "settings", "settingsVersion", "updatedAt", "username" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_publicKey_key" ON "Account"("publicKey");
CREATE UNIQUE INDEX "Account_githubUserId_key" ON "Account"("githubUserId");
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AccountChange_accountId_cursor_idx" ON "AccountChange"("accountId", "cursor");
