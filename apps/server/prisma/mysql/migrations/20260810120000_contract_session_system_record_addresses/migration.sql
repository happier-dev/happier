-- The operator-run final backfill/audit has excluded predecessor writers before
-- this CONTRACT migration. Run this explicit preflight before ALTER so MySQL's
-- non-strict coercions cannot turn a missed nullable expanded row into a
-- zero-filled contracted key. The duplicate primary-key insert is a hard
-- error in every supported sql_mode when an invalid or duplicate row exists.
CREATE TEMPORARY TABLE `_SessionSystemRecord_contract_preflight` (
    `ok` TINYINT NOT NULL PRIMARY KEY
);

INSERT INTO `_SessionSystemRecord_contract_preflight` (`ok`)
SELECT 1
UNION ALL
SELECT 1
FROM DUAL
WHERE EXISTS (
    SELECT 1
    FROM `SessionSystemRecord`
    WHERE `ownerKind` IS NULL
        OR `ownerKind` NOT IN ('host', 'plugin')
        OR (`ownerKind` = 'host' AND `pluginId` IS NOT NULL)
        OR (`ownerKind` = 'plugin' AND (`pluginId` IS NULL OR OCTET_LENGTH(`pluginId`) = 0))
        OR `namespaceAddressKey` IS NULL
        OR OCTET_LENGTH(`namespaceAddressKey`) <> 32
        OR `recordAddressKey` IS NULL
        OR OCTET_LENGTH(`recordAddressKey`) <> 32
        OR `version` < 1
        OR `version` > 2147483647
)
OR EXISTS (
    SELECT 1
    FROM `SessionSystemRecord`
    GROUP BY `accountId`, `sessionId`, `recordAddressKey`
    HAVING COUNT(*) > 1
);

DROP TEMPORARY TABLE `_SessionSystemRecord_contract_preflight`;

CREATE INDEX `SessionSystemRecord_sessionId_idx`
ON `SessionSystemRecord`(`sessionId`);

ALTER TABLE `SessionSystemRecord`
    DROP CHECK `SessionSystemRecord_ownerKind_check`,
    DROP INDEX `SessionSystemRecord_accountId_sessionId_namespace_localId_key`,
    DROP INDEX `SessionSystemRecord_account_kind_updated_idx`,
    DROP INDEX `SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx`,
    MODIFY `ownerKind` VARCHAR(16) NOT NULL,
    MODIFY `pluginId` LONGTEXT NULL,
    MODIFY `namespaceAddressKey` BINARY(32) NOT NULL,
    MODIFY `recordAddressKey` BINARY(32) NOT NULL,
    MODIFY `version` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `permissionTurnId` VARCHAR(191) NULL,
    ADD COLUMN `permissionRequestId` VARCHAR(256) NULL,
    ADD CONSTRAINT `SessionSystemRecord_owner_plugin_check`
        CHECK (
            (`ownerKind` = 'host' AND `pluginId` IS NULL)
            OR
            (`ownerKind` = 'plugin' AND `pluginId` IS NOT NULL AND CHAR_LENGTH(`pluginId`) > 0)
        ),
    ADD CONSTRAINT `SessionSystemRecord_permission_mediation_identity_check`
        CHECK (
            (
                `namespace` = 'permission'
                AND `kind` IN ('remote_settlement.v1', 'remote_grant.v1')
                AND (
                    (`permissionTurnId` IS NULL AND `permissionRequestId` IS NULL)
                    OR
                    (`permissionTurnId` IS NOT NULL AND `permissionRequestId` IS NOT NULL)
                )
            )
            OR
            (
                NOT (`namespace` = 'permission' AND `kind` IN ('remote_settlement.v1', 'remote_grant.v1'))
                AND `permissionTurnId` IS NULL
                AND `permissionRequestId` IS NULL
            )
        ),
    ADD UNIQUE INDEX `SessionSystemRecord_account_session_record_key`
        (`accountId`, `sessionId`, `recordAddressKey`),
    ADD INDEX `SessionSystemRecord_account_namespace_kind_updated_idx`
        (`accountId`, `sessionId`, `namespaceAddressKey`, `kind`, `updatedAt`, `id`);
