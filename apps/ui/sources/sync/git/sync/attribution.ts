export const ATTRIBUTION_INVALIDATION_WINDOW_MS = 10_000;

type InvalidationSource = 'unknown' | 'mutation';

export function shouldAttributeChangedPaths(input: {
    actorSessionId: string | null;
    actorSource: InvalidationSource | null;
    scopeSessionIds: string[];
    changedPathCount: number;
    invalidatedAt: number | null;
    now: number;
    freshnessWindowMs?: number;
}): boolean {
    if (!input.actorSessionId) return false;
    if (input.actorSource !== 'mutation') return false;
    if (input.changedPathCount <= 0) return false;
    if (input.scopeSessionIds.length !== 1) return false;
    if (!input.scopeSessionIds.includes(input.actorSessionId)) return false;
    if (input.invalidatedAt === null) return false;

    const windowMs = input.freshnessWindowMs ?? ATTRIBUTION_INVALIDATION_WINDOW_MS;
    return input.now - input.invalidatedAt <= windowMs;
}
