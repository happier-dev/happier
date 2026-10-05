import type { ReviewFinding, ReviewFindingOverlayEntry, ReviewFindingsOverlay, ScmDiffSummaryWalkthrough } from '@happier-dev/protocol';

import { formatReviewFindingLocation, REVIEW_SEVERITY_RANK } from '@/components/sessions/reviews/findings/reviewFindingPresentation';

/**
 * Where a review's findings sit in a walkthrough (Walkthrough lab WT5-R1, R3, R6). A pure presentation of
 * the protocol's findings overlay: a mapped finding is drawn once, beside the first stop that explains its
 * exact change, and the contents dot names it; a chip appears only where the narrator's prose cites the
 * finding; everything that cannot be placed stays reachable in the tail. Severity comes only from findings; a stop's importance never colours anything here.
 */
export type WalkthroughFindingView = Readonly<{
    key: string;
    runId: string;
    findingId: string;
    finding: ReviewFinding;
    severity: ReviewFinding['severity'];
    engineLabel: string;
    location: string | null;
}>;

/** no_file: the finding names no file · outdated: written against other or older code · not_in_story:
 * exact, but no stop explains that change · unplaced: its lines can't be placed exactly. */
export type WalkthroughFindingTailTag = 'no_file' | 'outdated' | 'not_in_story' | 'unplaced';

export type WalkthroughFindingTailEntry = WalkthroughFindingView & Readonly<{ tag: WalkthroughFindingTailTag }>;

export type WalkthroughReviewSummary = Readonly<{
    /** running: an engine is still reviewing · partial: an engine stopped without a complete result. */
    state: 'running' | 'partial' | 'complete';
    total: number;
    inStory: number;
    elsewhere: number;
    totalEngines: number;
    finishedEngines: number;
    runningEngines: number;
    failedEngineLabels: readonly string[];
    /** The engines (review backends) that stopped without a complete result, to retry on their own. */
    failedEngineIds: readonly string[];
    finishedEngineLabels: readonly string[];
    runningEngineLabels: readonly string[];
    engineLabels: readonly string[];
}>;

export type WalkthroughReviewOverlay = Readonly<{
    stops: ReadonlyMap<string, Readonly<{ cards: readonly WalkthroughFindingView[]; refs: readonly WalkthroughFindingView[] }>>;
    railSeverityByStopId: ReadonlyMap<string, ReviewFinding['severity']>;
    tail: readonly WalkthroughFindingTailEntry[];
    summary: WalkthroughReviewSummary;
    /** A narrator's citation (`findingId` or `runId:findingId`) to its finding, when it names exactly one. */
    viewsByReference: ReadonlyMap<string, WalkthroughFindingView>;
}>;

const EMPTY_STOP = Object.freeze({ cards: Object.freeze([]) as readonly WalkthroughFindingView[], refs: Object.freeze([]) as readonly WalkthroughFindingView[] });
export const EMPTY_WALKTHROUGH_STOP_FINDINGS = EMPTY_STOP;

function bySeverity(left: WalkthroughFindingView, right: WalkthroughFindingView): number {
    return (REVIEW_SEVERITY_RANK[left.severity] ?? 9) - (REVIEW_SEVERITY_RANK[right.severity] ?? 9);
}

function tailTagOf(entry: ReviewFindingOverlayEntry): WalkthroughFindingTailTag {
    if (entry.state === 'outdated') return 'outdated';
    if (entry.state === 'mapped') return 'not_in_story';
    if (!entry.finding.filePath) return 'no_file';
    return 'unplaced';
}

export function buildWalkthroughReviewOverlay(params: Readonly<{
    overlay: ReviewFindingsOverlay;
    stops: ScmDiffSummaryWalkthrough['stops'];
    /** The reviewer's name for each review Run ("Codex"); several Runs may share a backend. */
    reviewerLabelByRunId: Readonly<Record<string, string>>;
}>): WalkthroughReviewOverlay {
    const viewOf = (entry: ReviewFindingOverlayEntry): WalkthroughFindingView => ({
        key: entry.key,
        runId: entry.runRef.runId,
        findingId: entry.finding.id,
        finding: entry.finding,
        severity: entry.finding.severity,
        engineLabel: params.reviewerLabelByRunId[entry.runRef.runId] ?? entry.runRef.backendId,
        location: formatReviewFindingLocation(entry.finding),
    });
    const views = new Map(params.overlay.entries.map((entry) => [entry.key, viewOf(entry)] as const));
    // A narrator may cite a finding by its id, or by its owning Run and id when engines share ids.
    const byReference = new Map<string, WalkthroughFindingView[]>();
    for (const view of views.values()) {
        for (const reference of [view.findingId, `${view.runId}:${view.findingId}`]) {
            const list = byReference.get(reference) ?? [];
            list.push(view);
            byReference.set(reference, list);
        }
    }

    const cards = new Map<string, WalkthroughFindingView[]>();
    const refs = new Map<string, Map<string, WalkthroughFindingView>>();
    const addRef = (stopId: string, view: WalkthroughFindingView) => {
        const list = refs.get(stopId) ?? new Map<string, WalkthroughFindingView>();
        list.set(view.key, view);
        refs.set(stopId, list);
    };
    const stopIds = new Set(params.stops.map((stop) => stop.id));
    let inStory = 0;
    for (const entry of params.overlay.entries) {
        const placed = entry.state === 'mapped' ? entry.stopIds.filter((stopId) => stopIds.has(stopId)) : [];
        if (placed.length === 0) continue;
        inStory += 1;
        const view = views.get(entry.key)!;
        const list = cards.get(placed[0]!) ?? [];
        list.push(view);
        cards.set(placed[0]!, list);
    }
    for (const stop of params.stops) {
        for (const reference of stop.findingRefs ?? []) {
            const matches = byReference.get(reference);
            // An id two engines share is ambiguous without its Run; the chip is left out rather than guessed.
            if (matches?.length === 1) addRef(stop.id, matches[0]!);
        }
    }

    const stops = new Map<string, Readonly<{ cards: readonly WalkthroughFindingView[]; refs: readonly WalkthroughFindingView[] }>>();
    const railSeverityByStopId = new Map<string, ReviewFinding['severity']>();
    for (const stop of params.stops) {
        const stopRefs = [...(refs.get(stop.id)?.values() ?? [])].sort(bySeverity);
        const stopCards = [...(cards.get(stop.id) ?? [])].sort(bySeverity);
        if (stopRefs.length === 0 && stopCards.length === 0) continue;
        stops.set(stop.id, { cards: stopCards, refs: stopRefs });
        const most = [...stopCards, ...stopRefs].sort(bySeverity)[0];
        if (most) railSeverityByStopId.set(stop.id, most.severity);
    }

    const tail = params.overlay.entries
        .filter((entry) => !(entry.state === 'mapped' && entry.stopIds.some((stopId) => stopIds.has(stopId))))
        .map((entry): WalkthroughFindingTailEntry => ({ ...views.get(entry.key)!, tag: tailTagOf(entry) }));

    const reviews = params.overlay.reviews;
    const labelOf = (runId: string, backendId: string) => params.reviewerLabelByRunId[runId] ?? backendId;
    const running = reviews.filter((review) => review.status === 'running' || review.status === undefined);
    const finished = reviews.filter((review) => review.status === 'succeeded' && review.hasOutput
        && (review.reviewOutcome === undefined || review.reviewOutcome === 'complete') && !review.findingsTruncated);
    const failed = reviews.filter((review) => !running.includes(review) && !finished.includes(review));
    const state = failed.length > 0 ? 'partial' : running.length > 0 ? 'running' : params.overlay.status === 'incomplete' ? 'partial' : 'complete';
    const viewsByReference = new Map([...byReference.entries()].flatMap(([reference, matches]) => (
        matches.length === 1 ? [[reference, matches[0]!] as const] : [])));
    return {
        stops,
        railSeverityByStopId,
        tail,
        viewsByReference,
        summary: {
            state,
            total: params.overlay.entries.length,
            inStory,
            elsewhere: params.overlay.entries.length - inStory,
            totalEngines: reviews.length,
            finishedEngines: finished.length,
            runningEngines: running.length,
            failedEngineLabels: failed.map((review) => labelOf(review.runRef.runId, review.runRef.backendId)),
            failedEngineIds: [...new Set(failed.map((review) => review.runRef.backendId).filter(Boolean))],
            finishedEngineLabels: finished.map((review) => labelOf(review.runRef.runId, review.runRef.backendId)),
            runningEngineLabels: running.map((review) => labelOf(review.runRef.runId, review.runRef.backendId)),
            engineLabels: reviews.map((review) => labelOf(review.runRef.runId, review.runRef.backendId)),
        },
    };
}
