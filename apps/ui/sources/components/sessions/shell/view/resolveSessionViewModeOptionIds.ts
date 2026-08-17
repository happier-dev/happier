import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

const EMPTY_SESSION_MODE_OPTION_IDS: readonly string[] = Object.freeze([]);
const SESSION_VIEW_MODE_OPTION_IDS_CACHE = new LruMap<string, readonly string[]>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

type SessionViewModeOptionLike = Readonly<{
    id?: unknown;
}>;

/**
 * `agentId` is the canonical publishing-Agent discriminator for `sessionModesV1`. The legacy
 * `provider` alias exists only on the predecessor wire projection; the read path normalizes it
 * back to `agentId` and the strict envelope rejects it, so it never reaches this resolver.
 */
type SessionViewModeStateLike = Readonly<{
    agentId?: string | null;
    availableModes?: ReadonlyArray<SessionViewModeOptionLike> | null;
}> | null | undefined;

type SessionViewAgentCoreSessionModesLike = Readonly<{
    kind?: string;
    staticOptions?: ReadonlyArray<SessionViewModeOptionLike> | null;
}> | null | undefined;

function normalizeSessionViewModeOptionIds(
    options: ReadonlyArray<SessionViewModeOptionLike>,
): readonly string[] {
    const normalized = options
        .map((mode) => (typeof mode?.id === 'string' ? mode.id.trim() : ''))
        .filter((id: string) => id.length > 0);

    return normalized.length > 0 ? normalized : EMPTY_SESSION_MODE_OPTION_IDS;
}

export function resolveSessionViewModeOptionIds(
    agentId: string,
    sessionModeState: SessionViewModeStateLike,
    sessionModes: SessionViewAgentCoreSessionModesLike,
): readonly string[] {
    const cacheKey = JSON.stringify([
        agentId,
        sessionModeState?.agentId ?? null,
        Array.isArray(sessionModeState?.availableModes)
            ? sessionModeState.availableModes.map((mode) => (typeof mode?.id === 'string' ? mode.id.trim() : ''))
            : null,
        sessionModes?.kind ?? null,
        Array.isArray(sessionModes?.staticOptions)
            ? sessionModes.staticOptions.map((mode) => (typeof mode?.id === 'string' ? mode.id.trim() : ''))
            : null,
    ]);
    const cached = SESSION_VIEW_MODE_OPTION_IDS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    if (sessionModeState?.agentId === agentId && Array.isArray(sessionModeState.availableModes)) {
        const normalized = normalizeSessionViewModeOptionIds(sessionModeState.availableModes);
        SESSION_VIEW_MODE_OPTION_IDS_CACHE.set(cacheKey, normalized);
        return normalized;
    }

    if (sessionModes?.kind !== 'staticAgentModes') {
        SESSION_VIEW_MODE_OPTION_IDS_CACHE.set(cacheKey, EMPTY_SESSION_MODE_OPTION_IDS);
        return EMPTY_SESSION_MODE_OPTION_IDS;
    }
    if (!Array.isArray(sessionModes.staticOptions) || sessionModes.staticOptions.length === 0) {
        SESSION_VIEW_MODE_OPTION_IDS_CACHE.set(cacheKey, EMPTY_SESSION_MODE_OPTION_IDS);
        return EMPTY_SESSION_MODE_OPTION_IDS;
    }

    const normalized = normalizeSessionViewModeOptionIds(sessionModes.staticOptions);
    SESSION_VIEW_MODE_OPTION_IDS_CACHE.set(cacheKey, normalized);
    return normalized;
}
