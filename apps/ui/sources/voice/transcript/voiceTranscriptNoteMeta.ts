import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';

export const VOICE_TRANSCRIPT_NOTE_META_KIND = 'voice_note.v1';

export function buildVoiceTranscriptNoteMeta(): MessageMeta {
    return {
        happier: {
            kind: VOICE_TRANSCRIPT_NOTE_META_KIND,
            payload: { v: 1 },
        },
    };
}

export function hasVoiceTranscriptNoteMeta(meta: unknown): boolean {
    const happier = meta && typeof meta === 'object'
        ? (meta as { happier?: { kind?: unknown } }).happier
        : null;
    return happier?.kind === VOICE_TRANSCRIPT_NOTE_META_KIND;
}
