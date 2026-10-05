import type { ScmComparison, ScmComparisonSource, ScmDiffSummaryOutputKind } from '@happier-dev/protocol/scm';
import type { ScmDiffSummaryState } from './state';

type SourceSelector = (ScmComparisonSource | ScmReviewComparisonSelector) & Readonly<{ comparisonId?: string }>;

/** The selector a comparison view names, before the Session it belongs to is attached. */
export type ScmReviewComparisonSelector = (
    | Readonly<{ kind: 'workingTree' }>
    | Readonly<{ kind: 'session' }>
    | Readonly<{ kind: 'turnCheckpoint'; turnId?: string; checkpointReceiptId?: string; evidence?: 'agent_reported' | 'checkpoint' }>
    | Readonly<{ kind: 'branch'; head: string; base: string }>
    | Readonly<{ kind: 'commit'; commit: string; parent?: string }>
    | Pick<Extract<ScmComparisonSource, { kind: 'pullRequest' }>, 'kind' | 'locator'>
) & Readonly<{ comparisonId?: string }>;

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
    switch (comparison.kind) {
        case 'workingTree': return source.kind === 'workingTree';
        case 'session': return source.kind === 'session';
        case 'turnCheckpoint': {
            const requestedMode = 'evidence' in comparison ? comparison.evidence : 'evidenceMode' in comparison ? comparison.evidenceMode : undefined;
            return source.kind === 'turnCheckpoint'
            && Boolean(comparison.turnId || comparison.checkpointReceiptId)
            && (!comparison.turnId || source.turnId === comparison.turnId)
            && (!comparison.checkpointReceiptId || source.checkpointReceiptId === comparison.checkpointReceiptId)
            && (!requestedMode || requestedMode === (source.evidenceMode ?? 'reconciled'));
        }
        case 'branch': return source.kind === 'branch' && source.head === comparison.head && source.base === comparison.base;
        case 'commit': return source.kind === 'commit' && source.commit === comparison.commit && (source.parent ?? null) === (comparison.parent ?? null);
        case 'pullRequest': return source.kind === 'pullRequest' && source.locator.providerId === comparison.locator.providerId
            && source.locator.repository === comparison.locator.repository && source.locator.number === comparison.locator.number
            && (!comparison.locator.baseOid || comparison.locator.baseOid === (captured ? captured.pullRequest?.baseOid : source.locator.baseOid))
            && (!comparison.locator.headOid || comparison.locator.headOid === (captured?.endpoints.after ?? source.locator.headOid));
    }
}
/** Current output selection uses published results too: addOutputs need not change the initial request. */
export function selectSessionScmWalkthroughKey(state: ScmDiffSummaryState, sessionId: string,
    comparison: SourceSelector | null, output: ScmDiffSummaryOutputKind = 'walkthrough', scopeKey?: string): string | null {
    if (!comparison) return null;
    let best: { key: string; at: number } | null = null;
    for (const entry of Object.values(state.entriesByKey)) {
        const captured = entry.latestOutput?.comparison ?? entry.finalSummary?.output.comparison ?? entry.lastKnownSummary?.output.comparison;
        if (scopeKey !== undefined && entry.scopeKey !== scopeKey) continue;
        if (entry.sessionId !== sessionId || !scmReviewComparisonMatchesSource(comparison, entry.input.source, captured)) continue;
        if (comparison.comparisonId && comparison.comparisonId !== (entry.latestOutput?.comparison?.id
            ?? entry.finalSummary?.output.comparison?.id ?? entry.lastKnownSummary?.output.comparison?.id)) continue;
        if (!(entry.input.outputs ?? ['summary']).includes(output)
            && !entry.latestOutput?.outputs?.[output]
            && !entry.finalSummary?.output.outputs?.[output]
            && !entry.lastKnownSummary?.output.outputs?.[output]) continue;
        const at = entry.requestedAtMs ?? 0;
        if (!best || at >= best.at) best = { key: entry.key, at };
    }
    return best?.key ?? null;
}
