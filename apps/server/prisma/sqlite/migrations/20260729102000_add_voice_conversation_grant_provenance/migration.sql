-- Persist the quota grant classification after the pruneable lease is removed.
ALTER TABLE "VoiceConversation" ADD COLUMN "grantedBy" TEXT;
ALTER TABLE "VoiceConversation" ADD COLUMN "grantPeriodKey" TEXT;

-- Rolling-deploy compatibility: an older server can still write a completed
-- conversation without grantedBy and then delete its lease through either
-- cleanup path. Preserve the lease-owned value at the database deletion
-- boundary before ON DELETE SET NULL removes the relation.
--
-- Remove this trigger only after every deployed/rollback cleanup caller uses
-- the provenance-aware owner.
CREATE TRIGGER "VoiceSessionLease_preserve_conversation_grant"
BEFORE DELETE ON "VoiceSessionLease"
FOR EACH ROW
BEGIN
    UPDATE "VoiceConversation"
    SET "grantedBy" = COALESCE("grantedBy", OLD."grantedBy"),
        "grantPeriodKey" = COALESCE("grantPeriodKey", OLD."periodKey")
    WHERE "leaseId" = OLD."id"
      AND (
          "grantedBy" IS NULL
          OR "grantPeriodKey" IS NULL
      );
END;

-- Preserve exact known provenance for completed rows whose lease still exists.
-- Rows whose lease was already pruned remain NULL (legacy/unknown). Install the
-- rolling adapter first so an old cleanup worker cannot race the backfill.
UPDATE "VoiceConversation"
SET "grantedBy" = (
    SELECT lease."grantedBy"
    FROM "VoiceSessionLease" AS lease
    WHERE lease."id" = "VoiceConversation"."leaseId"
),
"grantPeriodKey" = (
    SELECT lease."periodKey"
    FROM "VoiceSessionLease" AS lease
    WHERE lease."id" = "VoiceConversation"."leaseId"
)
WHERE (
      "grantedBy" IS NULL
      OR "grantPeriodKey" IS NULL
  )
  AND "leaseId" IS NOT NULL;
