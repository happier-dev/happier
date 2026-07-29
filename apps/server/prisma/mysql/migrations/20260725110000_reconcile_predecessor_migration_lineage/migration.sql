-- Preserve the remote-dev migration ledger and move its physical schema to the
-- current canonical names and widths through an append-only transition.

ALTER TABLE `SessionTurn`
    RENAME COLUMN `provider` TO `agentId`,
    RENAME COLUMN `providerTurnId` TO `agentTurnId`,
    RENAME COLUMN `providerRollbackOrdinal` TO `agentRollbackOrdinal`,
    RENAME INDEX `SessionTurn_sessionId_provider_providerTurnId_idx`
    TO `SessionTurn_sessionId_agentId_agentTurnId_idx`;

ALTER TABLE `ConnectedServiceUsageSource`
    DROP FOREIGN KEY `csus_paur_fkey`,
    ADD CONSTRAINT `csus_record_fkey`
        FOREIGN KEY (`accountId`, `providerAccountUsageRecordId`)
        REFERENCES `ProviderAccountUsageRecord`(`accountId`, `recordId`)
        ON DELETE CASCADE ON UPDATE CASCADE,
    RENAME INDEX `csus_paur_idx` TO `csus_record_idx`;

ALTER TABLE `SessionSystemRecord`
    MODIFY COLUMN `namespace` VARCHAR(64) NOT NULL,
    MODIFY COLUMN `kind` VARCHAR(64) NOT NULL,
    RENAME INDEX `ssr_account_session_kind_updated_id_idx`
    TO `SessionSystemRecord_account_kind_updated_idx`;

ALTER TABLE `SessionOrganizationOrderEntry`
    MODIFY COLUMN `scopeKind` VARCHAR(64) NOT NULL,
    MODIFY COLUMN `itemKind` VARCHAR(64) NOT NULL;
ALTER TABLE `SessionOrganizationLabel`
    MODIFY COLUMN `labelKind` VARCHAR(191) NOT NULL;
