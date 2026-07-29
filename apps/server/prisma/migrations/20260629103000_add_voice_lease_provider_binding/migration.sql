-- Add the final durable provider conversation binding for voice leases.
ALTER TABLE "VoiceSessionLease" ADD COLUMN "providerId" TEXT;
ALTER TABLE "VoiceSessionLease" ADD COLUMN "providerConversationId" TEXT;
ALTER TABLE "VoiceSessionLease" ADD COLUMN "providerBindingNonce" TEXT;

CREATE UNIQUE INDEX "VoiceSessionLease_providerBindingNonce_key"
ON "VoiceSessionLease"("providerBindingNonce");
CREATE INDEX "VoiceSessionLease_provider_binding_lookup_idx"
ON "VoiceSessionLease"("accountId", "providerId", "providerConversationId");
