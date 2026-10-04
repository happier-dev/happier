import type { ExecutionRunStatus, ExecutionRunStructuredRunRef, ReviewCommentAnchorV1, ReviewFinding } from '../index.js';
import type { ScmChangeOccurrence, ScmComparison, ScmComparisonFile, ScmDiffSummaryWalkthrough } from '../scm/index.js';

export type ReviewFindingsOverlayReview = Readonly<{
    runRef: ExecutionRunStructuredRunRef;
    comparisonId?: string;
    findings: readonly ReviewFinding[];
    status?: ExecutionRunStatus;
    hasOutput: boolean;
    findingsTruncated?: boolean;
    reviewOutcome?: 'complete' | 'partial' | 'failed' | 'unavailable';
    anchorsByFindingId?: Readonly<Record<string, ReviewCommentAnchorV1>>;
}>;
export type ReviewFindingOverlayEntry = Readonly<{
    key: string;
    runRef: ExecutionRunStructuredRunRef;
    finding: ReviewFinding;
    state: 'mapped' | 'unmapped' | 'outdated';
    reason?: 'comparison_unbound' | 'comparison_mismatch' | 'comparison_stale' | 'evidence_unavailable' | 'evidence_ambiguous' | 'location_missing' | 'side_ambiguous';
    side?: 'before' | 'after';
    changeRefs: readonly string[];
    stopIds: readonly string[];
}>;
export type ReviewFindingsOverlay = Readonly<{
    status: 'clean' | 'findings' | 'incomplete';
    reviews: readonly ReviewFindingsOverlayReview[];
    entries: readonly ReviewFindingOverlayEntry[];
    /** Unattached findings, including exact mapped changes with no walkthrough stop. */
    tail: readonly ReviewFindingOverlayEntry[];
}>;

/** Deterministic local projection. Findings never generate prose or change importance/marks. */
export function projectReviewFindingsOverlay(params: Readonly<{
    comparison: ScmComparison;
    walkthrough?: ScmDiffSummaryWalkthrough | null;
    reviews: readonly ReviewFindingsOverlayReview[];
}>): ReviewFindingsOverlay {
    const stopsByChange = new Map<string, string[]>();
    for (const stop of params.walkthrough?.stops ?? []) {
        for (const ref of stop.changeRefs) {
            const stopIds = stopsByChange.get(ref) ?? [];
            if (!stopIds.includes(stop.id)) stopIds.push(stop.id);
            stopsByChange.set(ref, stopIds);
        }
    }
    const filesByPath = new Map<string, ScmComparisonFile[]>();
    for (const file of params.comparison.inventory.files) {
        for (const path of new Set([file.path, file.previousPath].filter((path): path is string => Boolean(path)))) {
            const files = filesByPath.get(path) ?? [];
            files.push(file);
            filesByPath.set(path, files);
        }
    }
    const entries = params.reviews.flatMap((review) => review.findings.map((finding): ReviewFindingOverlayEntry => {
        const base = { key: JSON.stringify([review.runRef.runId, review.runRef.callId, review.runRef.backendId, finding.id]), runRef: review.runRef, finding };
        const unmatched = (reason: NonNullable<ReviewFindingOverlayEntry['reason']>, state: 'unmapped' | 'outdated' = 'unmapped'): ReviewFindingOverlayEntry => ({
            ...base, state, reason, changeRefs: [], stopIds: [],
        });
        if (!review.comparisonId) return unmatched('comparison_unbound');
        if (review.comparisonId !== params.comparison.id) return unmatched('comparison_mismatch', 'outdated');
        if (params.comparison.freshness === 'stale') return unmatched('comparison_stale', 'outdated');
        const anchor = review.anchorsByFindingId?.[finding.id];
        // Hunk renderer IDs and file-only locations are navigation hints, not exact occurrences.
        if (anchor && anchor.kind !== 'line' && anchor.kind !== 'range') return unmatched('location_missing');
        const path = anchor?.filePath ?? finding.filePath;
        const start = anchor?.kind === 'line' ? anchor.line : anchor?.startLine ?? finding.startLine;
        const end = anchor?.kind === 'line' ? anchor.line : anchor?.endLine ?? finding.endLine ?? start;
        if (!path || !start || !end || end < start) return unmatched('location_missing');
        const files = filesByPath.get(path) ?? [];
        if (files.length === 0) return unmatched('location_missing');
        const matches: { side: 'before' | 'after'; occurrence: ScmChangeOccurrence; available: boolean }[] = [];
        for (const file of files) {
            for (const occurrence of file.occurrences) {
                for (const side of ['before', 'after'] as const) {
                    if (anchor?.side && anchor.side !== side) continue;
                    const sidePath = side === 'before' ? occurrence.previousPath ?? file.previousPath ?? occurrence.path : occurrence.path;
                    const range = occurrence[side];
                    if (sidePath !== path || range.lineCount === 0 || end < range.startLine || start >= range.startLine + range.lineCount) continue;
                    matches.push({ side, occurrence, available: occurrence.evidence?.state === 'available'
                        || (!occurrence.evidence && file.evidence.state === 'available') });
                }
            }
        }
        if (matches.length === 0) {
            return unmatched(files.some((file) => file.evidence.state === 'unavailable') ? 'evidence_unavailable' : 'location_missing');
        }
        if (matches.some((match) => !match.available)) return unmatched('evidence_unavailable');
        const sides = new Set(matches.map((match) => match.side));
        if (sides.size > 1) return unmatched('side_ambiguous');
        // A pending file can carry several independent index/worktree comparisons. Their line
        // coordinates do not choose an endpoint/layer, even when the path and side are the same.
        const bases = new Set(matches.map(({ occurrence }) => JSON.stringify([
            occurrence.layer ?? 'combined', occurrence.path, occurrence.previousPath ?? null,
            occurrence.beforeBlobId ?? null, occurrence.afterBlobId ?? null,
        ])));
        if (bases.size > 1) return unmatched('evidence_ambiguous');
        const changeRefs = [...new Set(matches.map((match) => match.occurrence.id))];
        const stopIds = [...new Set(changeRefs.flatMap((ref) => stopsByChange.get(ref) ?? []))];
        return { ...base, state: 'mapped', side: matches[0]!.side, changeRefs, stopIds };
    }));
    const evidenceAvailable = params.comparison.inventory.files.every((file) => file.occurrences.length > 0
        ? file.occurrences.every((occurrence) => (occurrence.evidence?.state ?? file.evidence.state) === 'available')
        : file.evidence.state === 'available');
    const complete = params.comparison.inventory.state === 'complete' && evidenceAvailable && params.reviews.length > 0 && params.reviews.every((review) => (
        review.hasOutput && review.status === 'succeeded' && !review.findingsTruncated
        && (review.reviewOutcome === undefined || review.reviewOutcome === 'complete')
        && review.comparisonId === params.comparison.id && params.comparison.freshness !== 'stale'
    ));
    return {
        status: complete ? (entries.length > 0 ? 'findings' : 'clean') : 'incomplete',
        reviews: params.reviews,
        entries,
        tail: entries.filter((entry) => entry.state !== 'mapped' || entry.stopIds.length === 0),
    };
}
