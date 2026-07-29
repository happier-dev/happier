-- Add the final durable provider conversation binding for voice leases.
ALTER TABLE `VoiceSessionLease`
    ADD COLUMN `providerId` VARCHAR(191) NULL,
    ADD COLUMN `providerConversationId` VARCHAR(191) NULL,
    ADD COLUMN `providerBindingNonce` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `VoiceSessionLease_providerBindingNonce_key`
ON `VoiceSessionLease`(`providerBindingNonce`);
CREATE INDEX `VoiceSessionLease_provider_binding_lookup_idx`
ON `VoiceSessionLease`(`accountId`, `providerId`, `providerConversationId`);
