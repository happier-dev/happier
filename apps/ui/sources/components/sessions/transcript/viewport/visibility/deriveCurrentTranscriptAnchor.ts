import type { NavigationVisibilitySnapshot } from './transcriptNavigationVisibilityStore';

export type TranscriptNavigationAnchorKind =
    | 'user-turn'
    | 'pinned-user'
    | 'pinned-assistant'
    | 'pinned-tool'
    | 'deep-link-target';

export type TranscriptNavigationAnchorCandidate = Readonly<{
    id: string;
    kind: TranscriptNavigationAnchorKind;
    sourceIndex: number;
}>;

export type TranscriptVisibleSourceRange = Readonly<{
    firstSourceIndex: number;
    lastSourceIndex: number;
}>;

export type DeriveCurrentTranscriptAnchorInput = Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    preferUserTurnAnchor?: boolean;
    topVisibleAnchorId?: string | null;
    visibleAnchorIds?: readonly string[];
    visibleSourceRange?: TranscriptVisibleSourceRange | null;
}>;

function isValidSourceIndex(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
}

function isValidRange(range: TranscriptVisibleSourceRange | null | undefined): range is TranscriptVisibleSourceRange {
    return (
        !!range &&
        isValidSourceIndex(range.firstSourceIndex) &&
        isValidSourceIndex(range.lastSourceIndex) &&
        range.firstSourceIndex <= range.lastSourceIndex
    );
}

function normalizeAnchorId(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeAnchors(
    anchors: readonly TranscriptNavigationAnchorCandidate[],
): readonly TranscriptNavigationAnchorCandidate[] {
    return anchors
        .filter((anchor) => normalizeAnchorId(anchor.id) !== null && isValidSourceIndex(anchor.sourceIndex))
        .slice()
        .sort((left, right) => {
            if (left.sourceIndex !== right.sourceIndex) return left.sourceIndex - right.sourceIndex;
            return left.id.localeCompare(right.id);
        });
}

function dedupeAnchorIds(ids: readonly string[], knownIds: ReadonlySet<string>): readonly string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of ids) {
        const id = normalizeAnchorId(value);
        if (!id || !knownIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

function resolveVisibleAnchorIds(params: Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    knownIds: ReadonlySet<string>;
    visibleAnchorIds?: readonly string[];
    visibleSourceRange?: TranscriptVisibleSourceRange | null;
}>): readonly string[] {
    if (params.visibleAnchorIds) {
        return dedupeAnchorIds(params.visibleAnchorIds, params.knownIds);
    }
    if (!isValidRange(params.visibleSourceRange)) return [];
    return params.anchors
        .filter((anchor) => (
            anchor.sourceIndex >= params.visibleSourceRange!.firstSourceIndex &&
            anchor.sourceIndex <= params.visibleSourceRange!.lastSourceIndex
        ))
        .map((anchor) => anchor.id);
}

export function deriveCurrentTranscriptAnchor(
    input: DeriveCurrentTranscriptAnchorInput,
): NavigationVisibilitySnapshot {
    const anchors = normalizeAnchors(input.anchors);
    if (anchors.length === 0) {
        return { currentAnchorId: null, visibleAnchorIds: [] };
    }
    const knownIds = new Set(anchors.map((anchor) => anchor.id));
    const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor] as const));
    const visibleAnchorIds = resolveVisibleAnchorIds({
        anchors,
        knownIds,
        visibleAnchorIds: input.visibleAnchorIds,
        visibleSourceRange: input.visibleSourceRange,
    });
    const topVisibleAnchorId = normalizeAnchorId(input.topVisibleAnchorId);
    if (input.preferUserTurnAnchor === true && visibleAnchorIds.length > 0) {
        const currentAnchorId = visibleAnchorIds.find((id) => anchorsById.get(id)?.kind === 'user-turn') ?? topVisibleAnchorId ?? visibleAnchorIds[0] ?? null;
        return {
            currentAnchorId,
            visibleAnchorIds: topVisibleAnchorId && knownIds.has(topVisibleAnchorId) && !visibleAnchorIds.includes(topVisibleAnchorId)
                ? [topVisibleAnchorId, ...visibleAnchorIds]
                : visibleAnchorIds,
        };
    }
    if (topVisibleAnchorId && knownIds.has(topVisibleAnchorId)) {
        return {
            currentAnchorId: topVisibleAnchorId,
            visibleAnchorIds: visibleAnchorIds.includes(topVisibleAnchorId)
                ? visibleAnchorIds
                : [topVisibleAnchorId, ...visibleAnchorIds],
        };
    }
    if (visibleAnchorIds.length === 0) {
        return { currentAnchorId: null, visibleAnchorIds: [] };
    }

    const currentAnchorId = input.preferUserTurnAnchor === true
        ? visibleAnchorIds.find((id) => anchorsById.get(id)?.kind === 'user-turn') ?? visibleAnchorIds[0] ?? null
        : visibleAnchorIds[0] ?? null;

    return {
        currentAnchorId,
        visibleAnchorIds,
    };
}
