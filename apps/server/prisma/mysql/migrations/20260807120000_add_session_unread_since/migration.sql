-- AlterTable
ALTER TABLE `Session` ADD COLUMN `unreadSince` DATETIME(3) NULL;

-- Backfill the materialized unread fact from the previous derived predicate
-- (`seq > COALESCE(lastViewedSessionSeq, 0)`). `updatedAt` is the closest durable proxy for
-- "when this session last changed"; the exact historical read -> unread instant is not recoverable.
UPDATE `Session`
SET `unreadSince` = `updatedAt`
WHERE `seq` > COALESCE(`lastViewedSessionSeq`, 0);
