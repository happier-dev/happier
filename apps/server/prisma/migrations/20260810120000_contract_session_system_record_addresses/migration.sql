-- This CONTRACT migration follows the explicit final backfill/audit. It deliberately
-- refuses expanded-only rows instead of guessing an address from predecessor fields.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "SessionSystemRecord"
        WHERE "ownerKind" IS NULL
            OR "ownerKind" NOT IN ('host', 'plugin')
            OR ("ownerKind" = 'host' AND "pluginId" IS NOT NULL)
            OR ("ownerKind" = 'plugin' AND ("pluginId" IS NULL OR octet_length("pluginId") = 0))
            OR "namespaceAddressKey" IS NULL
            OR octet_length("namespaceAddressKey") <> 32
            OR "recordAddressKey" IS NULL
            OR octet_length("recordAddressKey") <> 32
            OR "version" < 1
            OR "version" > 2147483647
    ) THEN
        RAISE EXCEPTION
            'SessionSystemRecord address CONTRACT cannot finalize: run the canonical backfill/audit with predecessor writers excluded';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "SessionSystemRecord"
        GROUP BY "accountId", "sessionId", "recordAddressKey"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'SessionSystemRecord address CONTRACT cannot finalize: duplicate derived record address';
    END IF;
END $$;

ALTER TABLE "SessionSystemRecord"
    DROP CONSTRAINT "SessionSystemRecord_ownerKind_check",
    ALTER COLUMN "ownerKind" SET NOT NULL,
    ALTER COLUMN "namespaceAddressKey" SET NOT NULL,
    ALTER COLUMN "recordAddressKey" SET NOT NULL,
    ADD COLUMN "permissionTurnId" VARCHAR(191),
    ADD COLUMN "permissionRequestId" VARCHAR(256),
    ADD CONSTRAINT "SessionSystemRecord_owner_plugin_check"
        CHECK (
            ("ownerKind" = 'host' AND "pluginId" IS NULL)
            OR
            ("ownerKind" = 'plugin' AND "pluginId" IS NOT NULL AND octet_length("pluginId") > 0)
        ),
    ADD CONSTRAINT "SessionSystemRecord_namespaceAddressKey_length_check"
        CHECK (octet_length("namespaceAddressKey") = 32),
    ADD CONSTRAINT "SessionSystemRecord_recordAddressKey_length_check"
        CHECK (octet_length("recordAddressKey") = 32),
    ADD CONSTRAINT "SessionSystemRecord_permission_mediation_identity_check"
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
        );

CREATE INDEX "SessionSystemRecord_sessionId_idx"
ON "SessionSystemRecord"("sessionId");

DROP INDEX "SessionSystemRecord_accountId_sessionId_namespace_localId_key";
DROP INDEX "SessionSystemRecord_account_kind_updated_idx";
DROP INDEX "SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx";

CREATE UNIQUE INDEX "SessionSystemRecord_account_session_record_key"
ON "SessionSystemRecord"("accountId", "sessionId", "recordAddressKey");
CREATE INDEX "SessionSystemRecord_account_namespace_kind_updated_idx"
ON "SessionSystemRecord"(
    "accountId",
    "sessionId",
    "namespaceAddressKey",
    "kind",
    "updatedAt" DESC,
    "id" DESC
);
