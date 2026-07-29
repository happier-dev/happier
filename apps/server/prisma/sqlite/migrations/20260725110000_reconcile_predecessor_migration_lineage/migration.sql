-- Preserve the remote-dev migration ledger and move its physical schema to the
-- current canonical names through an append-only transition.

ALTER TABLE "SessionTurn" RENAME COLUMN "provider" TO "agentId";
ALTER TABLE "SessionTurn" RENAME COLUMN "providerTurnId" TO "agentTurnId";
ALTER TABLE "SessionTurn" RENAME COLUMN "providerRollbackOrdinal" TO "agentRollbackOrdinal";

DROP INDEX "SessionTurn_sessionId_provider_providerTurnId_idx";
CREATE INDEX "SessionTurn_sessionId_agentId_agentTurnId_idx"
ON "SessionTurn"("sessionId", "agentId", "agentTurnId");

DROP INDEX "ssr_account_session_kind_updated_id_idx";
CREATE INDEX "SessionSystemRecord_account_kind_updated_idx"
ON "SessionSystemRecord"("accountId", "sessionId", "namespace", "kind", "updatedAt", "id");

-- The V4 activation rebuilds ConnectedServiceUsageSource with its canonical
-- foreign-key and index names. ProviderAccountUsageRecord remains in place.
DROP INDEX "paur_identity_key";
CREATE UNIQUE INDEX "paur_scope_key"
ON "ProviderAccountUsageRecord"(
    "accountId", "providerId", "accountSubjectId", "quotaScope", "quotaScopeIdKey"
);
