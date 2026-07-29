-- Preserve the remote-dev migration ledger and move its physical schema to the
-- current canonical names through an append-only transition.

ALTER TABLE "SessionTurn" RENAME COLUMN "provider" TO "agentId";
ALTER TABLE "SessionTurn" RENAME COLUMN "providerTurnId" TO "agentTurnId";
ALTER TABLE "SessionTurn" RENAME COLUMN "providerRollbackOrdinal" TO "agentRollbackOrdinal";

ALTER INDEX "SessionTurn_sessionId_provider_providerTurnId_idx"
RENAME TO "SessionTurn_sessionId_agentId_agentTurnId_idx";

ALTER INDEX "ssr_account_session_kind_updated_id_idx"
RENAME TO "SessionSystemRecord_account_kind_updated_idx";

ALTER TABLE "ConnectedServiceUsageSource"
RENAME CONSTRAINT "csus_paur_fkey" TO "csus_record_fkey";

ALTER INDEX "paur_identity_key" RENAME TO "paur_scope_key";
ALTER INDEX "csus_paur_idx" RENAME TO "csus_record_idx";
