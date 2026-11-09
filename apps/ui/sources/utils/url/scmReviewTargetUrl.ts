import type { SessionScmReviewTarget } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

/** Shared comparison addressing for review destinations and file links. */
export function serializeScmReviewTarget(target: SessionScmReviewTarget): Record<string, string> {
    const out: Record<string, string> = {};
    if (target.evidenceSessionId) out.evidenceSessionId = target.evidenceSessionId;
    const comparison = target.comparison;
    if (comparison) {
        out.comparison = comparison.kind;
        if (comparison.comparisonId) out.comparisonId = comparison.comparisonId;
        if (comparison.savedResult) {
            out.scmResultId = comparison.savedResult.resultId;
            out.scmResultCwd = comparison.savedResult.cwd;
        }
        if (comparison.kind === 'turnCheckpoint') {
            if (comparison.turnId) out.turnId = comparison.turnId;
            if (comparison.checkpointReceiptId) out.checkpointReceiptId = comparison.checkpointReceiptId;
            if (comparison.evidence) out.evidence = comparison.evidence;
        }
        if (comparison.kind === 'branch') { out.head = comparison.head; out.base = comparison.base; }
        if (comparison.kind === 'revisionRange') { out.baseOid = comparison.baseOid; out.headOid = comparison.headOid; }
        if (comparison.kind === 'commit') {
            out.commit = comparison.commit;
            if (comparison.parent) out.parent = comparison.parent;
        }
        if (comparison.kind === 'pullRequest') out.pullRequest = JSON.stringify(comparison.locator);
    }
    if (target.view) out.view = target.view;
    if (typeof target.explain === 'boolean') out.explain = String(target.explain);
    return out;
}
