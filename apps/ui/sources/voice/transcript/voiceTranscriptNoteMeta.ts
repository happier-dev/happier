import type { MessageMeta } from "@happier-dev/session-core/messages";
import { z } from 'zod';

export const VOICE_TRANSCRIPT_NOTE_META_KIND = 'voice_note.v1';

const nonBlank = z.string().refine((value) => value.trim().length > 0 && value === value.trim());
const continuationSchema = z.object({
    v: z.literal(1),
    deviceId: nonBlank,
    deviceDisplayName: nonBlank.nullable().optional(),
    conversation: z.object({ serverId: nonBlank, sessionId: nonBlank }).strict(),
}).strict();
export const VoiceTranscriptNotePayloadSchema = z.object({ v: z.literal(1), continuation: continuationSchema.optional() }).strict();
export type VoiceContinuationProvenance = z.infer<typeof continuationSchema>;

export function buildVoiceTranscriptNoteMeta(input?: Readonly<{ continuation: VoiceContinuationProvenance }>): MessageMeta {
    return {
        happier: {
            kind: VOICE_TRANSCRIPT_NOTE_META_KIND,
            payload: VoiceTranscriptNotePayloadSchema.parse({ v: 1, ...(input ? { continuation: input.continuation } : {}) }),
        },
    };
}

/** Missing predecessor notes remain ordinary notes; unknown or malformed data never controls capture. */
export function readVoiceContinuationProvenance(meta: unknown): VoiceContinuationProvenance | null {
    if (!hasVoiceTranscriptNoteMeta(meta)) return null;
    const happier = (meta as Readonly<{ happier: Readonly<{ payload?: unknown }> }>).happier;
    const result = VoiceTranscriptNotePayloadSchema.safeParse(happier.payload);
    return result.success ? result.data.continuation ?? null : null;
}

export function hasVoiceTranscriptNoteMeta(meta: unknown): boolean {
    const happier = meta && typeof meta === 'object'
        ? (meta as { happier?: { kind?: unknown } }).happier
        : null;
    return happier?.kind === VOICE_TRANSCRIPT_NOTE_META_KIND;
}
