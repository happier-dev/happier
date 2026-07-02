import type {
    TranscriptViewportListImplementation,
    TranscriptViewportPlatform,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

type TranscriptWarmPaintRecord = Readonly<{
    committedMessagesCount: number;
    items: number;
    latestCommittedActivityKey: string;
    listImplementation: TranscriptViewportListImplementation;
    observedAtMs: number;
    platform: TranscriptViewportPlatform;
}>;

type TranscriptWarmPaintStore = Map<string, TranscriptWarmPaintRecord>;

const TRANSCRIPT_WARM_PAINT_CACHE_GLOBAL_KEY = '__HAPPIER_TRANSCRIPT_WARM_PAINT_CACHE__';
const TRANSCRIPT_WARM_PAINT_CACHE_MAX_SESSIONS = 16;
const TRANSCRIPT_WARM_PAINT_CACHE_TTL_MS = 10 * 60 * 1000;

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
    listImplementation: TranscriptViewportListImplementation;
    platform: TranscriptViewportPlatform;
    sessionId: string;
}>): string {
    return `${params.platform}:${params.listImplementation}:${params.sessionId}`;
}

function isNativeFlashList(params: Readonly<{
    listImplementation: TranscriptViewportListImplementation;
    platform: TranscriptViewportPlatform;
}>): boolean {
    return params.platform !== 'web' && params.listImplementation === 'flash_v2';
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
    listImplementation: TranscriptViewportListImplementation;
    nowMs?: number;
    platform: TranscriptViewportPlatform;
    routeHydrationPending?: boolean;
    sessionId: string;
}>): void {
    if (!isNativeFlashList(params)) return;
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
        listImplementation: params.listImplementation,
        platform: params.platform,
        sessionId,
    });
    store.delete(key);
    store.set(key, {
        committedMessagesCount,
        items,
        latestCommittedActivityKey,
        listImplementation: params.listImplementation,
        observedAtMs,
        platform: params.platform,
    });
    enforceCacheLimit(store);
}

export function hasTranscriptWarmStablePaint(params: Readonly<{
    committedMessagesCount: number;
    items: number;
    latestCommittedActivityKey: string | null;
    listImplementation: TranscriptViewportListImplementation;
    nowMs?: number;
    platform: TranscriptViewportPlatform;
    routeHydrationPending?: boolean;
    sessionId: string;
}>): boolean {
    if (!isNativeFlashList(params)) return false;
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
        listImplementation: params.listImplementation,
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

    return (
        record.committedMessagesCount === committedMessagesCount &&
        record.items === items &&
        record.latestCommittedActivityKey === latestCommittedActivityKey
    );
}

export function __resetTranscriptWarmPaintCacheForTests(): void {
    getStore().clear();
}
