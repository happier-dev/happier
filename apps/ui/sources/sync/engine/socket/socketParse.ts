import { z } from 'zod';
import {
    DirectTranscriptRawMessageV1Schema,
    SessionStoredMessageContentSchema,
} from '@happier-dev/protocol';
import type {
    DirectTranscriptRawMessageV1,
    SessionStoredMessageContent,
} from '@happier-dev/protocol';
import { EphemeralUpdateSchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';
import type { UpdateContainer, EphemeralUpdate } from '@happier-dev/protocol/updates';

export type TranscriptStreamSegmentEphemeralUpdate = Readonly<{
    type: 'transcript-stream-segment';
    sessionId: string;
    message: Readonly<{
        localId: string;
        sidechainId?: string | null;
        content: SessionStoredMessageContent;
        createdAt: number;
        updatedAt: number;
    }>;
}>;

export type DirectSessionTranscriptUpdatedEphemeralUpdate = Readonly<{
    type: 'direct-session-transcript-delta';
    sessionId: string;
    items: ReadonlyArray<DirectTranscriptRawMessageV1>;
    nextCursor?: string | null;
    tailCursor?: string | null;
    truncated?: boolean;
}>;

export type ParsedEphemeralUpdate =
    | EphemeralUpdate
    | TranscriptStreamSegmentEphemeralUpdate
    | DirectSessionTranscriptUpdatedEphemeralUpdate;

const TranscriptStreamSegmentEphemeralUpdateSchema = z.object({
    type: z.literal('transcript-stream-segment'),
    sessionId: z.string(),
    message: z.object({
        localId: z.string(),
        sidechainId: z.string().nullable().optional(),
        content: SessionStoredMessageContentSchema,
        createdAt: z.number(),
        updatedAt: z.number(),
    }).passthrough(),
}).passthrough();

const DirectSessionTranscriptUpdatedEphemeralUpdateSchema = z.object({
    type: z.literal('direct-session-transcript-delta'),
    sessionId: z.string(),
    items: z.array(DirectTranscriptRawMessageV1Schema),
    nextCursor: z.string().nullable().optional(),
    tailCursor: z.string().nullable().optional(),
    truncated: z.boolean().optional(),
}).passthrough();

const LegacySharingUpdateBodySchema = z.discriminatedUnion('t', [
    z.object({
        t: z.literal('session-shared'),
        sessionId: z.string(),
        shareId: z.string().optional(),
    }).passthrough(),
    z.object({
        t: z.literal('session-share-updated'),
        sessionId: z.string(),
        shareId: z.string().optional(),
    }).passthrough(),
    z.object({
        t: z.literal('session-share-revoked'),
        sessionId: z.string(),
        shareId: z.string().optional(),
    }).passthrough(),
    z.object({
        t: z.literal('public-share-created'),
        sessionId: z.string(),
        publicShareId: z.string().optional(),
    }).passthrough(),
    z.object({
        t: z.literal('public-share-updated'),
        sessionId: z.string(),
        publicShareId: z.string().optional(),
    }).passthrough(),
    z.object({
        t: z.literal('public-share-deleted'),
        sessionId: z.string(),
    }).passthrough(),
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
    return validatedUpdate.data;
}

export function parseEphemeralUpdate(update: unknown): ParsedEphemeralUpdate | null {
    const validatedUpdate = EphemeralUpdateSchema.safeParse(update);
    if (!validatedUpdate.success) {
        const transcriptStreamSegmentUpdate = TranscriptStreamSegmentEphemeralUpdateSchema.safeParse(update);
        if (transcriptStreamSegmentUpdate.success) {
            return transcriptStreamSegmentUpdate.data;
        }

        const directSessionTranscriptDeltaUpdate = DirectSessionTranscriptUpdatedEphemeralUpdateSchema.safeParse(update);
        if (directSessionTranscriptDeltaUpdate.success) {
            return directSessionTranscriptDeltaUpdate.data;
        }

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
    return validatedUpdate.data as ParsedEphemeralUpdate;
}
