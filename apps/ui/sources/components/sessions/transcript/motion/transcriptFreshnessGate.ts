const TRANSCRIPT_UTTERANCE_IDENTITY_PREFIX = 'utterance:';

export function resolveTranscriptUtteranceIdentity(localId: string | null | undefined): string | null {
    if (typeof localId !== 'string' || localId.length === 0) return null;
    return `${TRANSCRIPT_UTTERANCE_IDENTITY_PREFIX}${localId}`;
}

export type TranscriptFreshnessQuery = Readonly<{
    id: string;
    createdAt: number;
    /** Content identities painted by this row across projection-shape handovers. */
    paintedIds?: readonly string[] | null;
}>;

export type TranscriptFreshnessGate = {
    isFresh: (params: TranscriptFreshnessQuery) => boolean;
    consumeFreshness: (params: TranscriptFreshnessQuery) => boolean;
    markPainted: (ids: readonly string[] | null | undefined) => void;
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
    const markPainted = (ids: readonly string[] | null | undefined) => {
        if (!Array.isArray(ids)) return;
        for (const id of ids) markSeen(id);
    };

    const isFresh = (params: TranscriptFreshnessQuery) => {
        const id = params.id;
        if (typeof id !== 'string' || id.length === 0) return false;
        if (seen.has(id)) return false;
        if (Array.isArray(params.paintedIds)) {
            for (const paintedId of params.paintedIds) {
                if (typeof paintedId === 'string' && seen.has(paintedId)) return false;
            }
        }

        const createdAt = params.createdAt;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return false;
        const now = opts.getNowMs();
        if (typeof now !== 'number' || !Number.isFinite(now)) return false;

        const age = now - createdAt;
        if (age > freshnessMs) return false;

        return true;
    };

    const consumeFreshness = (params: TranscriptFreshnessQuery) => {
        if (!isFresh(params)) return false;
        seen.add(params.id);
        markPainted(params.paintedIds);
        return true;
    };

    return { isFresh, consumeFreshness, markPainted, markSeen, isSeen };
}
