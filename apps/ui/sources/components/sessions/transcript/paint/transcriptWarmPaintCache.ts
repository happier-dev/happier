import type { TranscriptViewportPlatform } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

type TranscriptWarmPaintRecord = Readonly<{
    committedMessagesCount: number;
    items: number;
    latestCommittedActivityKey: string;
    observedAtMs: number;
    platform: TranscriptViewportPlatform;
}>;

type TranscriptWarmPaintStore = Map<string, TranscriptWarmPaintRecord>;

const TRANSCRIPT_WARM_PAINT_CACHE_GLOBAL_KEY = '__HAPPIER_TRANSCRIPT_WARM_PAINT_CACHE__';
/**
 * A record is four scalars and a session id, so the cap exists only to stop unbounded growth —
 * not to ration anything. At 16 it rationed: swiping through a session list evicted the very
 * sessions being swiped between, and each eviction costs a full first-paint placeholder on the
 * next visit. Hundreds of records are still a few tens of kilobytes.
 */
const TRANSCRIPT_WARM_PAINT_CACHE_MAX_SESSIONS = 256;

/**
 * Staleness is decided by the CONTENT check below, not by age: a record that no longer describes
 * the transcript cannot match however fresh it is, and one that still describes it is still true
 * however old. This bound exists so a long-lived process eventually forgets sessions the reader
 * has abandoned, which is a memory concern rather than a correctness one.
 */
const TRANSCRIPT_WARM_PAINT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function getStore(): TranscriptWarmPaintStore {
    const root = globalThis as unknown as Record<string, unknown>;
    const existing = root[TRANSCRIPT_WARM_PAINT_CACHE_GLOBAL_KEY];
    if (existing instanceof Map) {
        return existing as TranscriptWarmPaintStore;
    }
    const next: TranscriptWarmPaintStore = new Map();
    root[TRANSCRIPT_WARM_PAINT_CACHE_GLOBAL_KEY] = next;
    return next;
}

function normalizeSessionId(sessionId: string): string | null {
    const normalized = String(sessionId ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizePositiveInteger(value: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function normalizeLatestCommittedActivityKey(value: string | null): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function buildCacheKey(params: Readonly<{
    platform: TranscriptViewportPlatform;
    sessionId: string;
}>): string {
    return `${params.platform}:${params.sessionId}`;
}

function isNativePlatform(params: Readonly<{
    platform: TranscriptViewportPlatform;
}>): boolean {
    return params.platform !== 'web';
}

function enforceCacheLimit(store: TranscriptWarmPaintStore): void {
    while (store.size > TRANSCRIPT_WARM_PAINT_CACHE_MAX_SESSIONS) {
        const oldestKey = store.keys().next().value;
        if (typeof oldestKey !== 'string') return;
        store.delete(oldestKey);
    }
}

export function rememberTranscriptWarmStablePaint(params: Readonly<{
    committedMessagesCount: number;
    items: number;
    latestCommittedActivityKey: string | null;
    nowMs?: number;
    platform: TranscriptViewportPlatform;
    routeHydrationPending?: boolean;
    sessionId: string;
}>): void {
    if (!isNativePlatform(params)) return;
    if (params.routeHydrationPending === true) return;

    const sessionId = normalizeSessionId(params.sessionId);
    const committedMessagesCount = normalizePositiveInteger(params.committedMessagesCount);
    const items = normalizePositiveInteger(params.items);
    const latestCommittedActivityKey = normalizeLatestCommittedActivityKey(params.latestCommittedActivityKey);
    if (!sessionId || committedMessagesCount === null || items === null || !latestCommittedActivityKey) {
        return;
    }

    const observedAtMs =
        typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
            ? Math.trunc(params.nowMs)
            : Date.now();
    const store = getStore();
    const key = buildCacheKey({
        platform: params.platform,
        sessionId,
    });
    store.delete(key);
    store.set(key, {
        committedMessagesCount,
        items,
        latestCommittedActivityKey,
        observedAtMs,
        platform: params.platform,
    });
    enforceCacheLimit(store);
}

export function hasTranscriptWarmStablePaint(params: Readonly<{
    committedMessagesCount: number;
    items: number;
    latestCommittedActivityKey: string | null;
    nowMs?: number;
    platform: TranscriptViewportPlatform;
    routeHydrationPending?: boolean;
    sessionId: string;
}>): boolean {
    if (!isNativePlatform(params)) return false;
    if (params.routeHydrationPending === true) return false;

    const sessionId = normalizeSessionId(params.sessionId);
    const committedMessagesCount = normalizePositiveInteger(params.committedMessagesCount);
    const items = normalizePositiveInteger(params.items);
    const latestCommittedActivityKey = normalizeLatestCommittedActivityKey(params.latestCommittedActivityKey);
    if (!sessionId || committedMessagesCount === null || items === null || !latestCommittedActivityKey) {
        return false;
    }

    const store = getStore();
    const key = buildCacheKey({
        platform: params.platform,
        sessionId,
    });
    const record = store.get(key);
    if (!record) return false;

    const nowMs =
        typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
            ? Math.trunc(params.nowMs)
            : Date.now();
    if (nowMs - record.observedAtMs > TRANSCRIPT_WARM_PAINT_CACHE_TTL_MS) {
        return false;
    }

    // Warmth answers "has this transcript's geometry already been measured", and APPENDED
    // messages do not invalidate that — the measured rows are still the rows above the new
    // ones, and revealing through them is exactly the stale-while-revalidate behaviour the
    // transcript already has. Requiring an identical signature meant any message arriving in a
    // live agent session dropped the next open back to the slow first-paint placeholder, which
    // is the common case rather than the edge case.
    //
    // Shrinking is different and is refused: a tail reset, a fork or a retention eviction can
    // leave fewer rows than were measured, so the geometry may describe rows that are gone.
    if (record.latestCommittedActivityKey === latestCommittedActivityKey) {
        return record.committedMessagesCount === committedMessagesCount && record.items === items;
    }
    return committedMessagesCount >= record.committedMessagesCount && items >= record.items;
}

export function __resetTranscriptWarmPaintCacheForTests(): void {
    getStore().clear();
}
