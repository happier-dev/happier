CREATE TABLE "SessionSystemRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "SessionSystemRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionSystemRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SessionSystemRecord_accountId_sessionId_namespace_localId_key"
ON "SessionSystemRecord"("accountId", "sessionId", "namespace", "localId");

CREATE INDEX "SessionSystemRecord_accountId_sessionId_namespace_kind_updatedAt_id_idx"
ON "SessionSystemRecord"("accountId", "sessionId", "namespace", "kind", "updatedAt", "id");

CREATE INDEX "SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx"
ON "SessionSystemRecord"("sessionId", "namespace", "kind", "updatedAt", "id");
