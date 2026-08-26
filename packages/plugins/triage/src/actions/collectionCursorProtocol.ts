import { defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

/**
 * The generic Account Collection cursor carried by plugin-private Actions.
 *
 * It mirrors the host's published opaque-cursor contract. Callers may retain
 * and return the bytes to the Collection owner, but may not decode or persist
 * them. Keeping the schema here gives every private Triage Collection pager
 * one wire spelling without creating a cursor owner outside Data.
 */
export const TriageCollectionCursorV1Schema = defineProtocolString({
    minLength: 1,
    maxLength: 4096,
    pattern: '^[A-Za-z0-9_-]+$',
});
