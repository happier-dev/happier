-- SQLite has no built-in SHA-256. Add nullable rolling-migration columns and
-- retain the old exact-value indexes for legacy rows until the host backfill
-- gate has populated every digest. New server writes always dual-write the key.
ALTER TABLE "VoiceSessionLease" ADD COLUMN "providerConversationKey" TEXT;
ALTER TABLE "VoiceConversation" ADD COLUMN "providerConversationKey" TEXT;

CREATE UNIQUE INDEX "VoiceConversation_providerId_providerConversationKey_key"
ON "VoiceConversation"("providerId", "providerConversationKey");
CREATE INDEX "VoiceSessionLease_provider_binding_key_lookup_idx"
ON "VoiceSessionLease"("accountId", "providerId", "providerConversationKey");
