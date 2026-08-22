/**
 * Literal vectors consumed by Channels core and Session-spawn tests. The
 * derivation is intentionally not reimplemented here: the canonical owner
 * must prove that its creation-key implementation produces this exact value.
 */
export const CHANNEL_NEW_CREATION_VECTOR_V1 = Object.freeze({
  bindingId: 'binding-01',
  commandOccurrenceId: 'telegram-update-9001',
  expectedCreationKey: 'channel-new:binding-01:telegram-update-9001',
});
