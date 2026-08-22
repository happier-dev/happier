import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Readonly<Record<string, unknown>>;
}

/**
 * The one identity a stored message is projected under in the Voice transcript.
 *
 * The canonical local id is preferred because it survives the optimistic →
 * persisted transition: a server id arrives later and would otherwise remount
 * the rendered row and orphan any projection keyed to it (interruption marks,
 * scroll anchors). Every reader and writer of transcript-entry identity uses
 * this owner so a projection can never be keyed under an identity the
 * transcript does not render.
 */
export function resolveVoiceTranscriptEntryId(message: unknown): string | null {
    const record = readRecord(message);
    if (!record) return null;
    return normalizeNonEmptyString(
        typeof record.localId === 'string'
            ? record.localId
            : typeof record.realID === 'string'
                ? record.realID
                : typeof record.id === 'string'
                    ? record.id
                    : null,
    );
}
