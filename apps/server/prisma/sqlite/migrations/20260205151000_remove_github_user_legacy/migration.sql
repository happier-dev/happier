-- Drop legacy GitHub linkage on Account in favor of AccountIdentity(provider="github").

INSERT OR IGNORE INTO "AccountIdentity" (
    "id",
    "accountId",
    "provider",
    "providerUserId",
    "providerLogin",
    "profile",
    "token",
    "createdAt",
    "updatedAt"
)
SELECT
    'gh-legacy-' || a."id",
    a."id",
    'github',
    a."githubUserId",
    json_extract(g."profile", '$.login'),
    g."profile",
    g."token",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Account" a
LEFT JOIN "GithubUser" g ON g."id" = a."githubUserId"
WHERE a."githubUserId" IS NOT NULL;

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
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "avatar" TEXT
);
INSERT INTO "new_Account" ("avatar", "changesFloor", "contentPublicKey", "contentPublicKeySig", "createdAt", "feedSeq", "firstName", "id", "lastName", "publicKey", "seq", "settings", "settingsVersion", "updatedAt", "username") SELECT "avatar", "changesFloor", "contentPublicKey", "contentPublicKeySig", "createdAt", "feedSeq", "firstName", "id", "lastName", "publicKey", "seq", "settings", "settingsVersion", "updatedAt", "username" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_publicKey_key" ON "Account"("publicKey");
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- DropTable
DROP TABLE IF EXISTS "GithubUser";
