-- RedefineTables
--
-- SQLite cannot drop NOT NULL constraints via ALTER TABLE.
-- We redefine Account to make publicKey nullable.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT,
    "contentPublicKey" BLOB,
    "contentPublicKeySig" BLOB,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "changesFloor" INTEGER NOT NULL DEFAULT 0,
    "feedSeq" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "settings" TEXT,
    "settingsVersion" INTEGER NOT NULL DEFAULT 0,
    "encryptionMode" TEXT NOT NULL DEFAULT 'e2ee',
    "encryptionModeUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

