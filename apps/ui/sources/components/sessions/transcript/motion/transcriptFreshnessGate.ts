export type TranscriptFreshnessGate = {
    isFresh: (params: { id: string; createdAt: number }) => boolean;
    consumeFreshness: (params: { id: string; createdAt: number }) => boolean;
    markSeen: (id: string) => void;
    isSeen: (id: string) => boolean;
};

export function createTranscriptFreshnessGate(opts: {
    freshnessMs: number;
    getNowMs: () => number;
}): TranscriptFreshnessGate {
    const seen = new Set<string>();
    const freshnessMs = Number.isFinite(opts.freshnessMs) && opts.freshnessMs >= 0 ? Math.trunc(opts.freshnessMs) : 0;

    const isSeen = (id: string) => seen.has(id);
    const markSeen = (id: string) => {
        if (typeof id === 'string' && id.length > 0) {
            seen.add(id);
        }
    };

    const isFresh = (params: { id: string; createdAt: number }) => {
        const id = params.id;
        if (typeof id !== 'string' || id.length === 0) return false;
        if (seen.has(id)) return false;

        const createdAt = params.createdAt;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return false;
        const now = opts.getNowMs();
        if (typeof now !== 'number' || !Number.isFinite(now)) return false;

        const age = now - createdAt;
        if (age > freshnessMs) return false;

        return true;
    };

    const consumeFreshness = (params: { id: string; createdAt: number }) => {
        if (!isFresh(params)) return false;
        seen.add(params.id);
        return true;
    };

    return { isFresh, consumeFreshness, markSeen, isSeen };
}
