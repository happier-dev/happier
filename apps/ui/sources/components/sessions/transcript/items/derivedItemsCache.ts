import type { ChatListItemsBuildCache } from '@/components/sessions/chatListItems';
import type { TranscriptTurnsBuildCache } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { LruMap } from '@/utils/cache/lruMap';

const TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS = 16;

export type TranscriptDerivedItemsCacheEntry = {
    linearItemsCache: ChatListItemsBuildCache | null;
    turnsCache: TranscriptTurnsBuildCache | null;
};

const transcriptDerivedItemsCacheBySessionId = new LruMap<string, TranscriptDerivedItemsCacheEntry>({
    maxEntries: TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS,
});

export function resolveTranscriptDerivedItemsCacheMaxSessions(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return TRANSCRIPT_DERIVED_ITEMS_CACHE_FALLBACK_MAX_SESSIONS;
    }
    return Math.max(1, Math.min(64, Math.trunc(value)));
}

export function readTranscriptDerivedItemsCacheEntry(
    sessionId: string,
    maxSessions: number,
): TranscriptDerivedItemsCacheEntry {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(maxSessions);
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId);
    if (existing) return existing;
    const entry: TranscriptDerivedItemsCacheEntry = {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, entry);
    return entry;
}

export function writeTranscriptDerivedItemsCacheEntry(
    sessionId: string,
    maxSessions: number,
    patch: Partial<TranscriptDerivedItemsCacheEntry>,
): void {
    transcriptDerivedItemsCacheBySessionId.setMaxEntries(maxSessions);
    const existing = transcriptDerivedItemsCacheBySessionId.get(sessionId) ?? {
        linearItemsCache: null,
        turnsCache: null,
    };
    transcriptDerivedItemsCacheBySessionId.set(sessionId, {
        ...existing,
        ...patch,
    });
}
