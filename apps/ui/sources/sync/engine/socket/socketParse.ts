import { z } from 'zod/mini';
import type { ExternalSessionTranscriptInvalidationV1 } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { EphemeralUpdateSchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';
import type { UpdateContainer, EphemeralUpdate } from '@happier-dev/protocol/updates';

export type ExternalSessionTranscriptUpdatedEphemeralUpdate =
    ExternalSessionTranscriptInvalidationV1;

const LegacySharingUpdateBodySchema = z.discriminatedUnion('t', [
    z.looseObject({
        t: z.literal('session-shared'),
        sessionId: z.string(),
        shareId: z.optional(z.string()),
    }),
    z.looseObject({
        t: z.literal('session-share-updated'),
        sessionId: z.string(),
        shareId: z.optional(z.string()),
    }),
    z.looseObject({
        t: z.literal('session-share-revoked'),
        sessionId: z.string(),
        shareId: z.optional(z.string()),
    }),
    z.looseObject({
        t: z.literal('public-share-created'),
        sessionId: z.string(),
        publicShareId: z.optional(z.string()),
    }),
    z.looseObject({
        t: z.literal('public-share-updated'),
        sessionId: z.string(),
        publicShareId: z.optional(z.string()),
    }),
    z.looseObject({
        t: z.literal('public-share-deleted'),
        sessionId: z.string(),
    }),
]);

export function parseUpdateContainer(update: unknown): UpdateContainer | null {
    const validatedUpdate = UpdateContainerSchema.safeParse(update);
    if (!validatedUpdate.success) {
        // Compatibility fallback:
        // Some servers may emit `update.body` (or the `UpdateBody` itself) instead of the full container.
        // We only attempt to recover sharing-related updates to avoid mis-applying core message/session updates.
        //
        // NOTE: These legacy sharing update bodies are intentionally *not* validated against the full `UpdateBodySchema`
        // because older servers may omit fields that are required in the modern schema (e.g. DEK payloads).
        if (update && typeof update === 'object') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const maybeBody = (update as any).body ?? update;
            const parsedBody = LegacySharingUpdateBodySchema.safeParse(maybeBody);
            if (parsedBody.success) {
                return {
                    id: '',
                    seq: 0,
                    body: parsedBody.data as any,
                    createdAt: Date.now(),
                };
            }
        }

        // Don’t crash on unknown/forward-compatible socket updates.
        // In dev we still emit a warning to help catch schema drift.
        // eslint-disable-next-line no-undef
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.warn('⚠️ Sync: Ignoring unrecognized update payload');
        }
        return null;
    }
    const parsed = validatedUpdate.data;
    // Released Session writers use sid only as the compatibility alias of id.
    // Contradictory routing identities are malformed, not a content update.
    if (parsed.body.t === 'update-session' && Object.hasOwn(parsed.body, 'sid')
        && parsed.body.sid !== parsed.body.id) return null;
    return parsed;
}

export function parseEphemeralUpdate(update: unknown): EphemeralUpdate | null {
    const validatedUpdate = EphemeralUpdateSchema.safeParse(update);
    if (!validatedUpdate.success) {
        const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
        if (isDev) {
            console.error('Invalid ephemeral update received:', update);
        } else {
            const kind =
                update && typeof update === 'object' && 'type' in update && typeof (update as any).type === 'string'
                    ? (update as any).type
                    : typeof update;
            console.error('Invalid ephemeral update received (redacted)', { kind });
        }
        return null;
    }
    return validatedUpdate.data;
}
