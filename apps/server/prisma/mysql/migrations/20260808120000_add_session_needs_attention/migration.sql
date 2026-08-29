-- AlterTable
-- MySQL uses a VIRTUAL generated column so adding it remains an in-place operation. InnoDB
-- materializes virtual generated values in secondary indexes.
ALTER TABLE `Session` ADD COLUMN `needsAttention` BOOLEAN GENERATED ALWAYS AS (
    `seq` > COALESCE(`lastViewedSessionSeq`, 0)
    OR COALESCE(`latestTurnStatus`, '') = 'failed'
    OR `pendingPermissionRequestCount` > 0
    OR `pendingUserActionRequestCount` > 0
) VIRTUAL NOT NULL;

-- CreateIndex
CREATE INDEX `Session_accountId_needsAttention_meaningfulActivityAt_id_idx`
ON `Session`(`accountId`, `needsAttention`, `meaningfulActivityAt`, `id`);
