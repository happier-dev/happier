import {
    EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT,
    type NavigationVisibilitySnapshot,
} from './transcriptNavigationVisibilityStore';

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
    /**
     * The anchor a jump landing PUT the reader on, while that landing still owns
     * the viewport. Intent outranks geometric containment: a landing routinely
     * settles the renderer window one or two rows above the target row (the
     * previous turn's tail still grazes the viewport top), and index space cannot
     * tell that apart from genuinely reading the previous turn.
     */
    landedAnchorId?: string | null;
    preferUserTurnAnchor?: boolean;
    visibleSourceRange: TranscriptVisibleSourceRange | null | undefined;
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

function normalizeAnchors(
    anchors: readonly TranscriptNavigationAnchorCandidate[],
): readonly TranscriptNavigationAnchorCandidate[] {
    return anchors
        .filter((anchor) => (
            typeof anchor.id === 'string' &&
            anchor.id.length > 0 &&
            isValidSourceIndex(anchor.sourceIndex)
        ))
        .slice()
        .sort((left, right) => {
            if (left.sourceIndex !== right.sourceIndex) return left.sourceIndex - right.sourceIndex;
            return left.id.localeCompare(right.id);
        });
}

/**
 * Scrollspy containment in renderer index space: the current anchor is the
 * GREATEST anchor whose row starts at or above the leading visible row.
 *
 * Partial-visibility tie-break. An anchor sitting exactly at `firstSourceIndex`
 * is the leading row: it counts as landed whether its top has already scrolled a
 * little above the viewport edge or a freshly aligned jump placed it just below
 * it. An anchor BELOW the leading row is only peeking in from the bottom and
 * must not steal `current` from the turn whose body the reader is actually
 * inside — that turn's own prompt row is usually unmounted by virtualization,
 * which is precisely why this cannot be answered from mounted rows.
 */
function resolveContainingAnchorId(
    anchors: readonly TranscriptNavigationAnchorCandidate[],
    firstSourceIndex: number,
    requiredKind: TranscriptNavigationAnchorKind | null,
): string | null {
    let containing: TranscriptNavigationAnchorCandidate | null = null;
    for (const anchor of anchors) {
        if (anchor.sourceIndex > firstSourceIndex) break;
        if (requiredKind !== null && anchor.kind !== requiredKind) continue;
        containing = anchor;
    }
    return containing?.id ?? null;
}

export function deriveCurrentTranscriptAnchor(
    input: DeriveCurrentTranscriptAnchorInput,
): NavigationVisibilitySnapshot {
    const anchors = normalizeAnchors(input.anchors);
    const range = input.visibleSourceRange;
    if (anchors.length === 0 || !isValidRange(range)) {
        return EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT;
    }

    const visibleAnchorIds = anchors
        .filter((anchor) => (
            anchor.sourceIndex >= range.firstSourceIndex &&
            anchor.sourceIndex <= range.lastSourceIndex
        ))
        .map((anchor) => anchor.id);

    const landedAnchorId = typeof input.landedAnchorId === 'string' && input.landedAnchorId.length > 0
        ? input.landedAnchorId
        : null;

    const currentAnchorId = (
        (landedAnchorId !== null && anchors.some((anchor) => anchor.id === landedAnchorId)
            ? landedAnchorId
            : null)
        ?? (input.preferUserTurnAnchor === true
            ? resolveContainingAnchorId(anchors, range.firstSourceIndex, 'user-turn')
            : null)
        ?? resolveContainingAnchorId(anchors, range.firstSourceIndex, null)
        ?? visibleAnchorIds[0]
        ?? null
    );

    return { currentAnchorId, visibleAnchorIds };
}
