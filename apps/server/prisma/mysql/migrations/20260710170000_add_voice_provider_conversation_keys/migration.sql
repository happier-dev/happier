-- PREPARE phase for portable provider-conversation identity.
--
-- The moving remote-dev predecessor writes only providerId and
-- providerConversationId. Keep both digest columns nullable and retain the
-- legacy raw-value indexes so that writer, and a rollback reader, can coexist
-- with this schema. The application owns dual-write, legacy-read fallback,
-- exact raw-ID collision checks, and the bounded idempotent backfill.
--
-- A later release may make the conversation digest required, remove the
-- legacy indexes/fallback, and widen providerConversationId to VARCHAR(512)
-- only after predecessor and rollback writers are proven unreachable.
ALTER TABLE `VoiceSessionLease` ADD COLUMN `providerConversationKey` CHAR(64) NULL;
ALTER TABLE `VoiceConversation` ADD COLUMN `providerConversationKey` CHAR(64) NULL;

-- sessionId is not part of either provider-conversation index and can be
-- widened independently without preventing predecessor writes.
ALTER TABLE `VoiceSessionLease`
    MODIFY `sessionId` VARCHAR(512) NULL;

CREATE UNIQUE INDEX `VoiceConversation_providerId_providerConversationKey_key`
ON `VoiceConversation`(`providerId`, `providerConversationKey`);
CREATE INDEX `VoiceSessionLease_provider_binding_key_lookup_idx`
ON `VoiceSessionLease`(`accountId`, `providerId`, `providerConversationKey`);
