import type { ScmComparison, ScmComparisonSource, ScmComparisonView, ScmDiffSummaryOutputKind, ScmDiffSummaryOutputs, ScmDiffSummaryResultReadInput } from '@happier-dev/protocol/scm';
import type { ScmDiffSummaryState } from './state';
import { scmComparisonSourceMatches } from '@happier-dev/protocol/scm/comparison';

type SourceSelector = (ScmComparisonSource | ScmReviewComparisonSelector) & Readonly<{ comparisonId?: string }>;

/** Shared by semantic navigation and the comparison surface's reading-view fallback. */
export function scmReviewViewUnavailableReason(view: ScmComparisonView,
    comparison: Pick<ScmReviewComparisonSelector, 'kind'> | null | undefined): 'commits_require_working_tree' | null {
    return view === 'commits' && comparison?.kind !== 'workingTree' ? 'commits_require_working_tree' : null;
}

/** Only a terminal attempt with no published value needs an older saved output. */
export function scmDiffSummaryOutputNeedsPublishedFallback(output: ScmDiffSummaryOutputs[ScmDiffSummaryOutputKind]): boolean {
    return Boolean(output && output.value === undefined && (output.state === 'failed' || output.state === 'cancelled'));
}

/** The selector a comparison view names, before the Session it belongs to is attached. */
export type ScmReviewComparisonSelector = (
    | Readonly<{ kind: 'workingTree' }>
    | Readonly<{ kind: 'session' }>
    | Readonly<{ kind: 'turnCheckpoint'; turnId?: string; checkpointReceiptId?: string; evidence?: 'agent_reported' | 'checkpoint' }>
    | Readonly<{ kind: 'branch'; head: string; base: string }>
    | Readonly<{ kind: 'commit'; commit: string; parent?: string }>
    | Pick<Extract<ScmComparisonSource, { kind: 'pullRequest' }>, 'kind' | 'locator'>
) & Readonly<{
    comparisonId?: string;
    /** Exact cold-open address; later publications still follow the comparison's normal selection. */
    savedResult?: ScmDiffSummaryResultReadInput;
}>;

/** The captured-comparison source a comparison view asks the machine for (one mapping for every caller). */
export function scmComparisonSourceOf(comparison: ScmReviewComparisonSelector, sessionId: string): ScmComparisonSource {
    switch (comparison.kind) {
        case 'turnCheckpoint': return { kind: 'turnCheckpoint', ...(comparison.turnId ? { turnId: comparison.turnId } : {}),
            ...(comparison.checkpointReceiptId ? { checkpointReceiptId: comparison.checkpointReceiptId } : {}), evidenceMode: comparison.evidence ?? 'reconciled' };
        case 'session': return { kind: 'session', sessionId };
        case 'workingTree': return { kind: 'workingTree' };
        case 'branch': return { kind: 'branch', head: comparison.head, base: comparison.base };
        case 'commit': return { kind: 'commit', commit: comparison.commit, ...(comparison.parent ? { parent: comparison.parent } : {}) };
        case 'pullRequest': return { kind: 'pullRequest', locator: comparison.locator };
    }
}

/** A captured descriptor names its source and retains its exact basis when opened. */
export function scmReviewComparisonOfSource(source: ScmComparisonSource, comparisonId?: string): ScmReviewComparisonSelector | null {
    const captured = comparisonId ? { comparisonId } : {};
    if (source.kind === 'turnCheckpoint') return source.turnId || source.checkpointReceiptId
        ? { kind: 'turnCheckpoint', ...(source.turnId ? { turnId: source.turnId } : {}),
            ...(source.checkpointReceiptId ? { checkpointReceiptId: source.checkpointReceiptId } : {}),
            ...(source.evidenceMode === 'checkpoint' || source.evidenceMode === 'agent_reported' ? { evidence: source.evidenceMode } : {}), ...captured }
        : null;
    if (source.kind === 'session') return { kind: 'session', ...captured };
    return comparisonId ? { ...source, comparisonId } : { ...source };
}
export function scmReviewComparisonOfCaptured(comparison: Readonly<{ id: string; source: ScmComparisonSource }>): ScmReviewComparisonSelector | null {
    return scmReviewComparisonOfSource(comparison.source, comparison.id);
}
export function scmReviewComparisonMatchesSource(comparison: SourceSelector, source: ScmComparisonSource,
    captured?: Pick<ScmComparison, 'endpoints' | 'pullRequest'>): boolean {
    const viewEvidence = 'evidence' in comparison ? comparison.evidence : undefined;
    const sourceEvidence = 'evidenceMode' in comparison ? comparison.evidenceMode : undefined;
    const evidenceMode = viewEvidence === 'checkpoint' || viewEvidence === 'agent_reported' ? viewEvidence
        : sourceEvidence === 'checkpoint' || sourceEvidence === 'agent_reported' || sourceEvidence === 'reconciled' ? sourceEvidence : undefined;
    const selector: ScmComparisonSource = comparison.kind === 'session' ? { kind: 'session' as const,
        sessionId: 'sessionId' in comparison && typeof comparison.sessionId === 'string' ? comparison.sessionId : source.kind === 'session' ? source.sessionId : '' }
        : comparison.kind === 'turnCheckpoint' ? { kind: 'turnCheckpoint' as const,
            ...(comparison.turnId ? { turnId: comparison.turnId } : {}),
            ...(comparison.checkpointReceiptId ? { checkpointReceiptId: comparison.checkpointReceiptId } : {}),
            ...(evidenceMode ? { evidenceMode } : {}) }
        : comparison;
    return scmComparisonSourceMatches(selector, source, captured ? { baseOid: captured.pullRequest?.baseOid, headOid: captured.endpoints.after } : undefined);
}
/** Current output selection uses published results too: addOutputs need not change the initial request. */
export function selectSessionScmWalkthroughKey(state: ScmDiffSummaryState, sessionId: string,
    comparison: SourceSelector | null, output: ScmDiffSummaryOutputKind = 'walkthrough', scopeKey?: string): string | null {
    return selectScmWalkthroughKey(state, { sessionId }, comparison, output, scopeKey);
}

/** Exact host and checkout selection; Machine results never acquire Session authority. */
export function selectScmWalkthroughKey(state: ScmDiffSummaryState,
    host: Readonly<{ sessionId: string }> | Readonly<{ machineId: string; cwd: string }>,
    comparison: SourceSelector | null, output: ScmDiffSummaryOutputKind = 'walkthrough', scopeKey?: string): string | null {
    if (!comparison) return null;
    let best: { key: string; at: number; needsPublishedFallback: boolean } | null = null;
    let published: { key: string; at: number } | null = null;
    for (const entry of Object.values(state.entriesByKey)) {
        const captured = entry.latestOutput?.comparison ?? entry.finalSummary?.output.comparison ?? entry.lastKnownSummary?.output.comparison;
        if (scopeKey !== undefined && entry.scopeKey !== scopeKey) continue;
        const sameHost = 'sessionId' in host ? entry.sessionId === host.sessionId
            : entry.sessionId === null && entry.machineId === host.machineId && entry.input.cwd === host.cwd;
        if (!sameHost || !scmReviewComparisonMatchesSource(comparison, entry.input.source, captured)) continue;
        if (comparison.comparisonId && comparison.comparisonId !== (entry.latestOutput?.comparison?.id
            ?? entry.finalSummary?.output.comparison?.id ?? entry.lastKnownSummary?.output.comparison?.id
            ?? entry.input.comparisonId)) continue;
        const requestedOutput = entry.latestOutput?.outputs?.[output] ?? entry.finalSummary?.output.outputs?.[output]
            ?? entry.lastKnownSummary?.output.outputs?.[output];
        if (entry.savedResult && !requestedOutput) continue;
        if (!(entry.input.outputs ?? ['summary']).includes(output)
            && !entry.latestOutput?.outputs?.[output]
            && !entry.finalSummary?.output.outputs?.[output]
            && !entry.lastKnownSummary?.output.outputs?.[output]) continue;
        const at = entry.requestedAtMs ?? 0;
        if (requestedOutput?.value !== undefined && (!published || at >= published.at)) published = { key: entry.key, at };
        if (!best || at >= best.at) best = { key: entry.key, at,
            needsPublishedFallback: Boolean(entry.savedResult && scmDiffSummaryOutputNeedsPublishedFallback(requestedOutput)) };
    }
    if (best?.needsPublishedFallback && published) return published.key;
    return best?.key ?? null;
}
