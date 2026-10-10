-- Extend the existing binding scope in place; preserve all Team references and data.
-- The canonical executor honors these directives outside its transaction so
-- inbound ON DELETE RESTRICT references survive the parent-table replacement.
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TeamIdentityConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT,
    "providerInstanceId" TEXT NOT NULL,
    "externalReference" JSONB NOT NULL,
    "settings" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "firstEnabledAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastObservation" JSONB,
    "lastSuccessfulTestAt" DATETIME,
    "createdByAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeamIdentityConnection_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "TeamIdentityConnection_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TeamIdentityConnection_providerInstanceId_fkey" FOREIGN KEY ("providerInstanceId") REFERENCES "IdentityProviderInstance" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TeamIdentityConnection_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TeamIdentityConnection" ("id", "teamId", "providerInstanceId", "externalReference", "settings", "enabled", "firstEnabledAt", "revision", "lastObservation", "lastSuccessfulTestAt", "createdByAccountId", "createdAt", "updatedAt")
SELECT "id", "teamId", "providerInstanceId", "externalReference", "settings", "enabled", "firstEnabledAt", "revision", "lastObservation", "lastSuccessfulTestAt", "createdByAccountId", "createdAt", "updatedAt" FROM "TeamIdentityConnection";
DROP TABLE "TeamIdentityConnection";
ALTER TABLE "new_TeamIdentityConnection" RENAME TO "TeamIdentityConnection";
CREATE UNIQUE INDEX "TeamIdentityConnection_teamId_providerInstanceId_key" ON "TeamIdentityConnection"("teamId", "providerInstanceId");
CREATE UNIQUE INDEX "TeamIdentityConnection_id_teamId_key" ON "TeamIdentityConnection"("id", "teamId");
PRAGMA foreign_keys=ON;
