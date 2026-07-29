-- Persist the quota grant classification after the pruneable lease is removed.
ALTER TABLE "VoiceConversation"
ADD COLUMN "grantedBy" TEXT,
ADD COLUMN "grantPeriodKey" TEXT;

-- Rolling-deploy compatibility: an older server can still write a completed
-- conversation without grantedBy and then delete its lease through either
-- cleanup path. Preserve the lease-owned value at the database deletion
-- boundary before ON DELETE SET NULL removes the relation.
--
-- Remove this trigger/function only in a later append-only contraction after
-- every deployed/rollback cleanup caller uses the provenance-aware owner.
CREATE FUNCTION "preserveVoiceConversationGrantBeforeLeaseDelete"()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE "VoiceConversation"
    SET "grantedBy" = COALESCE("grantedBy", OLD."grantedBy"),
        "grantPeriodKey" = COALESCE("grantPeriodKey", OLD."periodKey")
    WHERE "leaseId" = OLD."id"
      AND (
          "grantedBy" IS NULL
          OR "grantPeriodKey" IS NULL
      );
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VoiceSessionLease_preserve_conversation_grant"
BEFORE DELETE ON "VoiceSessionLease"
FOR EACH ROW
EXECUTE FUNCTION "preserveVoiceConversationGrantBeforeLeaseDelete"();

-- Preserve exact known provenance for completed rows whose lease still exists.
-- Rows whose lease was already pruned remain NULL (legacy/unknown). Install the
-- rolling adapter first so an old cleanup worker cannot race the backfill.
UPDATE "VoiceConversation" AS conversation
SET "grantedBy" = COALESCE(conversation."grantedBy", lease."grantedBy"),
    "grantPeriodKey" = COALESCE(conversation."grantPeriodKey", lease."periodKey")
FROM "VoiceSessionLease" AS lease
WHERE conversation."leaseId" = lease."id"
  AND (
      conversation."grantedBy" IS NULL
      OR conversation."grantPeriodKey" IS NULL
  );
