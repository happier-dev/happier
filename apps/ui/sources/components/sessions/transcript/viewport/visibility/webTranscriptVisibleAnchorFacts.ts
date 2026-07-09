import type { NavigationVisibilitySnapshot } from './transcriptNavigationVisibilityStore';
import {
    deriveCurrentTranscriptAnchor,
    type TranscriptNavigationAnchorCandidate,
} from './deriveCurrentTranscriptAnchor';

export type WebTranscriptAnchorRowRect = Readonly<{
    anchorId: string;
    bottomPx: number;
    topPx: number;
}>;

export type WebTranscriptVisibleAnchorFacts = NavigationVisibilitySnapshot & Readonly<{
    shouldReleasePinnedReader: boolean;
}>;

export type WebTranscriptVisibleAnchorFactsInput = Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    preferUserTurnAnchor?: boolean;
    rows: readonly WebTranscriptAnchorRowRect[];
    scrollIntent?: Readonly<{
        isTrusted: boolean;
        programmaticScrollActive: boolean;
    }> | null;
    viewport: Readonly<{
        bottomPx: number;
        topPx: number;
    }>;
}>;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function intersectsViewport(
    row: WebTranscriptAnchorRowRect,
    viewport: WebTranscriptVisibleAnchorFactsInput['viewport'],
): boolean {
    return row.bottomPx > row.topPx && row.bottomPx > viewport.topPx && row.topPx < viewport.bottomPx;
}

export function deriveWebTranscriptVisibleAnchorFacts(
    input: WebTranscriptVisibleAnchorFactsInput,
): WebTranscriptVisibleAnchorFacts {
    const viewport = input.viewport;
    const viewportValid = (
        isFiniteNumber(viewport.topPx) &&
        isFiniteNumber(viewport.bottomPx) &&
        viewport.bottomPx > viewport.topPx
    );
    const shouldReleasePinnedReader =
        input.scrollIntent?.isTrusted === true &&
        input.scrollIntent.programmaticScrollActive !== true;
    if (!viewportValid) {
        return {
            currentAnchorId: null,
            visibleAnchorIds: [],
            shouldReleasePinnedReader: false,
        };
    }

    const seen = new Set<string>();
    const visibleRows = input.rows
        .filter((row) => (
            typeof row.anchorId === 'string' &&
            row.anchorId.length > 0 &&
            isFiniteNumber(row.topPx) &&
            isFiniteNumber(row.bottomPx) &&
            intersectsViewport(row, viewport)
        ))
        .slice()
        .sort((left, right) => {
            if (left.topPx !== right.topPx) return left.topPx - right.topPx;
            return left.bottomPx - right.bottomPx;
        });

    const visibleAnchorIds: string[] = [];
    for (const row of visibleRows) {
        if (seen.has(row.anchorId)) continue;
        seen.add(row.anchorId);
        visibleAnchorIds.push(row.anchorId);
    }
    const visibility = deriveCurrentTranscriptAnchor({
        anchors: input.anchors,
        preferUserTurnAnchor: input.preferUserTurnAnchor,
        topVisibleAnchorId: visibleAnchorIds[0] ?? null,
        visibleAnchorIds,
    });
    const activationLinePx = viewport.topPx + (viewport.bottomPx - viewport.topPx) * CONTAINMENT_ACTIVATION_LINE_RATIO;
    const containingAnchorId = input.preferUserTurnAnchor === true
        ? resolveContainingUserTurnAnchorId(input.anchors, input.rows, activationLinePx)
        : null;

    return {
        currentAnchorId: containingAnchorId ?? visibility.currentAnchorId,
        visibleAnchorIds: visibility.visibleAnchorIds,
        shouldReleasePinnedReader,
    };
}

const CONTAINMENT_ACTIVATION_LINE_RATIO = 0.2;

function resolveContainingUserTurnAnchorId(
    anchors: WebTranscriptVisibleAnchorFactsInput['anchors'],
    rows: readonly WebTranscriptAnchorRowRect[],
    activationLinePx: number,
): string | null {
    const userTurnAnchorIds = new Set<string>();
    for (const anchor of anchors) {
        if (anchor.kind === 'user-turn' && typeof anchor.id === 'string' && anchor.id.length > 0) {
            userTurnAnchorIds.add(anchor.id);
        }
    }
    let containing: WebTranscriptAnchorRowRect | null = null;
    for (const row of rows) {
        if (!userTurnAnchorIds.has(row.anchorId)) continue;
        if (!isFiniteNumber(row.topPx) || !isFiniteNumber(row.bottomPx) || row.bottomPx <= row.topPx) continue;
        if (row.topPx > activationLinePx) continue;
        if (!containing || row.topPx > containing.topPx) {
            containing = row;
        }
    }
    return containing?.anchorId ?? null;
}
