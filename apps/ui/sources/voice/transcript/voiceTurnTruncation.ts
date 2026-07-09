import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { estimateSpokenDurationMs } from '@/voice/output/ttsPlaybackTiming';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX } from './voiceTranscriptBounds';
import { truncateTextToPlayedBoundary } from './VoiceTranscriptProjector';
import { hasVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';

/**
 * Played-ms truncation registry (L3.T4).
 *
 * Barge-in interrupts the assistant mid-turn, but the assistant text was already
 * persisted in full (and the reducer-backed message store is append/merge
 * oriented — re-applying a shorter message will not shrink it). The transcript
 * the user sees is a projection of the store, so the canonical place to reflect
 * "what was actually heard" is the transcript display owner: this registry holds
 * a per-turn truncated-text override keyed by the transcript entry id, and the
 * voice transcript selector substitutes it when present.
 *
 * The map is bounded (LRU) so a long-lived session cannot grow it without bound,
 * and a monotonic version lets the selector's memo invalidate when an override
 * is recorded (the underlying message-slice reference does not change on a
 * barge-in).
 */
const truncatedTextByEntryId = new Map<string, string>();
let truncationVersion = 0;

function recordVoiceTurnTruncatedText(entryId: string, truncatedText: string): void {
    if (truncatedTextByEntryId.has(entryId)) {
        truncatedTextByEntryId.delete(entryId);
    } else if (truncatedTextByEntryId.size >= VOICE_TRANSCRIPT_SELECTOR_CACHE_MAX) {
        const oldestKey = truncatedTextByEntryId.keys().next().value;
        if (oldestKey !== undefined) truncatedTextByEntryId.delete(oldestKey);
    }
    truncatedTextByEntryId.set(entryId, truncatedText);
    truncationVersion += 1;
}

/** Truncated-text override for a transcript entry id, or `null` when untruncated. */
export function readVoiceTurnTruncatedText(entryId: string): string | null {
    const value = truncatedTextByEntryId.get(entryId);
    return value === undefined ? null : value;
}

/** Monotonic version; bumps whenever an override is recorded (memo invalidation). */
export function voiceTurnTruncationVersion(): number {
    return truncationVersion;
}

/** Test-only reset of the registry. */
export function __resetVoiceTurnTruncations(): void {
    truncatedTextByEntryId.clear();
    truncationVersion += 1;
}

type StoreLike = Readonly<{ sessionMessages?: Record<string, unknown> }>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Readonly<Record<string, unknown>>;
}

function resolveEntryId(record: Readonly<Record<string, unknown>>): string | null {
    return normalizeNonEmptyString(
        typeof record.realID === 'string'
            ? record.realID
            : typeof record.localId === 'string'
                ? record.localId
                : typeof record.id === 'string'
                    ? record.id
                    : null,
    );
}

function readAssistantText(record: Readonly<Record<string, unknown>>): string | null {
    // User turns and note turns are never the spoken assistant turn.
    if (record.kind === 'user-text' || record.role === 'user') return null;
    if (hasVoiceTranscriptNoteMeta(record.meta)) return null;
    if (record.kind === 'agent-text') {
        return typeof record.text === 'string' ? normalizeNonEmptyString(record.text) : null;
    }
    if (record.role === 'agent' && Array.isArray(record.content)) {
        for (const entry of record.content) {
            const textEntry = readRecord(entry);
            if (!textEntry || textEntry.type !== 'text' || typeof textEntry.text !== 'string') continue;
            return normalizeNonEmptyString(textEntry.text);
        }
    }
    return null;
}

function findLatestAssistantTurn(
    state: StoreLike,
    conversationSessionId: string,
): Readonly<{ entryId: string; fullText: string }> | null {
    const messages = readStoredSessionMessages(state as any, conversationSessionId);
    let best: Readonly<{ entryId: string; fullText: string; createdAt: number }> | null = null;
    for (const message of messages) {
        const record = readRecord(message);
        if (!record) continue;
        const fullText = readAssistantText(record);
        if (!fullText) continue;
        const entryId = resolveEntryId(record);
        if (!entryId) continue;
        const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0;
        if (!best || createdAt >= best.createdAt) {
            best = { entryId, fullText, createdAt };
        }
    }
    return best ? { entryId: best.entryId, fullText: best.fullText } : null;
}

/**
 * Truncate the most-recent assistant turn of `conversationSessionId` down to the
 * prefix that was actually heard, given the confirmed-played duration `playedMs`
 * at interrupt. No-op when the truncation would not change the text — played
 * through the whole turn, or `playedMs` unknown (`MAX_SAFE_INTEGER`) → full text
 * kept — so a clean completion leaves the transcript intact. Reuses the
 * canonical `truncateTextToPlayedBoundary` seam; the full spoken duration is
 * estimated from the turn text.
 */
export function truncateVoiceConversationAssistantTurnToPlayedBoundary(params: Readonly<{
    conversationSessionId: string;
    playedMs: number;
    getState?: () => StoreLike;
}>): void {
    const conversationSessionId = normalizeNonEmptyString(params.conversationSessionId);
    if (!conversationSessionId) return;
    if (!Number.isFinite(params.playedMs) || params.playedMs < 0) return;

    const state = (params.getState ?? (() => storage.getState() as StoreLike))();
    const turn = findLatestAssistantTurn(state, conversationSessionId);
    if (!turn) return;

    const spokenDurationMs = estimateSpokenDurationMs(turn.fullText);
    const truncated = truncateTextToPlayedBoundary(turn.fullText, params.playedMs, spokenDurationMs);
    // Only record a real change. An empty/whitespace result means nothing
    // meaningful was heard; keep the entry hidden by recording an empty override
    // (the selector drops empty entries) rather than surfacing a full turn the
    // user never heard.
    if (truncated === turn.fullText) return;
    recordVoiceTurnTruncatedText(turn.entryId, truncated);
}
