-- Persist the quota grant classification after the pruneable lease is removed.
ALTER TABLE `VoiceConversation`
ADD COLUMN `grantedBy` VARCHAR(191) NULL,
ADD COLUMN `grantPeriodKey` VARCHAR(191) NULL;

-- Rolling-deploy compatibility: an older server can still write a completed
-- conversation without grantedBy and then delete its lease through either
-- cleanup path. Preserve the lease-owned value at the database deletion
-- boundary before ON DELETE SET NULL removes the relation.
--
-- Remove this trigger only after every deployed/rollback cleanup caller uses
-- the provenance-aware owner.
CREATE TRIGGER `VoiceSessionLease_preserve_conversation_grant`
BEFORE DELETE ON `VoiceSessionLease`
FOR EACH ROW
UPDATE `VoiceConversation`
SET `grantedBy` = COALESCE(`grantedBy`, OLD.`grantedBy`),
    `grantPeriodKey` = COALESCE(`grantPeriodKey`, OLD.`periodKey`)
WHERE `leaseId` = OLD.`id`
  AND (
      `grantedBy` IS NULL
      OR `grantPeriodKey` IS NULL
  );

-- Preserve exact known provenance for completed rows whose lease still exists.
-- Rows whose lease was already pruned remain NULL (legacy/unknown). Install the
-- rolling adapter first so an old cleanup worker cannot race the backfill.
UPDATE `VoiceConversation` AS conversation
INNER JOIN `VoiceSessionLease` AS lease
    ON conversation.`leaseId` = lease.`id`
SET conversation.`grantedBy` = COALESCE(conversation.`grantedBy`, lease.`grantedBy`),
    conversation.`grantPeriodKey` = COALESCE(conversation.`grantPeriodKey`, lease.`periodKey`)
WHERE conversation.`grantedBy` IS NULL
   OR conversation.`grantPeriodKey` IS NULL;
