-- SQLite table replacement is destructive only after this explicit final-backfill
-- preflight. The named CHECK makes a missed audit failure identifiable to operators.
CREATE TEMP TABLE "_SessionSystemRecord_contract_preflight" (
    "ok" INTEGER NOT NULL,
    CONSTRAINT "SessionSystemRecord_contract_backfill_required" CHECK ("ok" = 1)
);

INSERT INTO "_SessionSystemRecord_contract_preflight" ("ok")
SELECT CASE WHEN
    EXISTS (
        SELECT 1
        FROM "SessionSystemRecord"
        WHERE "ownerKind" IS NULL
            OR "ownerKind" NOT IN ('host', 'plugin')
            OR ("ownerKind" = 'host' AND "pluginId" IS NOT NULL)
            OR ("ownerKind" = 'plugin' AND ("pluginId" IS NULL OR length("pluginId") = 0))
            OR "namespaceAddressKey" IS NULL
            OR length("namespaceAddressKey") <> 32
            OR "recordAddressKey" IS NULL
            OR length("recordAddressKey") <> 32
            OR "version" < 1
            OR "version" > 2147483647
    )
    OR EXISTS (
        SELECT 1
        FROM "SessionSystemRecord"
        GROUP BY "accountId", "sessionId", "recordAddressKey"
        HAVING COUNT(*) > 1
    )
THEN 0 ELSE 1 END;

DROP TABLE "_SessionSystemRecord_contract_preflight";

CREATE TABLE "new_SessionSystemRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "permissionTurnId" TEXT,
    "permissionRequestId" TEXT,
    "content" JSONB NOT NULL,
    "ownerKind" TEXT NOT NULL,
    "pluginId" TEXT,
    "namespaceAddressKey" BLOB NOT NULL,
    "recordAddressKey" BLOB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionSystemRecord_owner_plugin_check"
        CHECK (
            ("ownerKind" = 'host' AND "pluginId" IS NULL)
            OR
            ("ownerKind" = 'plugin' AND "pluginId" IS NOT NULL AND length("pluginId") > 0)
        ),
    CONSTRAINT "SessionSystemRecord_namespaceAddressKey_length_check"
        CHECK (length("namespaceAddressKey") = 32),
    CONSTRAINT "SessionSystemRecord_recordAddressKey_length_check"
        CHECK (length("recordAddressKey") = 32),
    CONSTRAINT "SessionSystemRecord_version_check"
        CHECK ("version" BETWEEN 1 AND 2147483647),
    CONSTRAINT "SessionSystemRecord_permission_mediation_identity_check"
        CHECK (
            (
                "namespace" = 'permission'
                AND "kind" IN ('remote_settlement.v1', 'remote_grant.v1')
                AND (
                    ("permissionTurnId" IS NULL AND "permissionRequestId" IS NULL)
                    OR
                    ("permissionTurnId" IS NOT NULL AND "permissionRequestId" IS NOT NULL)
                )
            )
            OR
            (
                NOT ("namespace" = 'permission' AND "kind" IN ('remote_settlement.v1', 'remote_grant.v1'))
                AND "permissionTurnId" IS NULL
                AND "permissionRequestId" IS NULL
            )
        ),
    CONSTRAINT "SessionSystemRecord_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionSystemRecord_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_SessionSystemRecord" (
    "id",
    "accountId",
    "sessionId",
    "namespace",
    "kind",
    "localId",
    "permissionTurnId",
    "permissionRequestId",
    "content",
    "ownerKind",
    "pluginId",
    "namespaceAddressKey",
    "recordAddressKey",
    "version",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "accountId",
    "sessionId",
    "namespace",
    "kind",
    "localId",
    NULL,
    NULL,
    "content",
    "ownerKind",
    "pluginId",
    "namespaceAddressKey",
    "recordAddressKey",
    "version",
    "createdAt",
    "updatedAt"
FROM "SessionSystemRecord";

DROP TABLE "SessionSystemRecord";
ALTER TABLE "new_SessionSystemRecord" RENAME TO "SessionSystemRecord";

CREATE UNIQUE INDEX "SessionSystemRecord_account_session_record_key"
ON "SessionSystemRecord"("accountId", "sessionId", "recordAddressKey");
CREATE INDEX "SessionSystemRecord_account_namespace_kind_updated_idx"
ON "SessionSystemRecord"(
    "accountId",
    "sessionId",
    "namespaceAddressKey",
    "kind",
    "updatedAt",
    "id"
);
CREATE INDEX "SessionSystemRecord_sessionId_idx"
ON "SessionSystemRecord"("sessionId");
