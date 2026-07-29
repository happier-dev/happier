-- PostgreSQL/PGlite rolling migration phase: add nullable digest columns and
-- retain the old exact-value indexes for legacy rows until the host backfill
-- gate has populated every digest. New server writes always dual-write the key.
-- This deliberately avoids a pgcrypto extension dependency, which is not
-- available in the supported embedded PGlite flavor.
ALTER TABLE "VoiceSessionLease" ADD COLUMN "providerConversationKey" TEXT;
ALTER TABLE "VoiceConversation" ADD COLUMN "providerConversationKey" TEXT;

CREATE UNIQUE INDEX "VoiceConversation_providerId_providerConversationKey_key"
ON "VoiceConversation"("providerId", "providerConversationKey");
CREATE INDEX "VoiceSessionLease_provider_binding_key_lookup_idx"
ON "VoiceSessionLease"("accountId", "providerId", "providerConversationKey");
