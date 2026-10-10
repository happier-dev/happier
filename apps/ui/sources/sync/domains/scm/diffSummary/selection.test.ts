import { afterEach, describe, expect, it } from 'vitest';
import { ScmDiffSummaryResultSchema } from '@happier-dev/protocol/scm';
import { getScmDiffSummaryState, loadSavedScmDiffSummaryResult, retireScmDiffSummaryScope } from '@/sync/ops/scmDiffSummary/generate';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { scmComparisonSourceOf, scmReviewComparisonMatchesSource, selectSessionScmWalkthroughKey } from './selection';

const scope = { serverId: 'selection-home', accountId: 'selection-account' };
afterEach(() => retireScmDiffSummaryScope(scope));
describe('captured comparison result selection', () => {
    it('matches explicit Session evidence only to that Session while a view selector remains host-relative', () => {
        const source = { kind: 'session' as const, sessionId: 'session-a' };
        expect(scmReviewComparisonMatchesSource({ kind: 'session', sessionId: 'session-b' }, source)).toBe(false);
        expect(scmReviewComparisonMatchesSource(source, source)).toBe(true);
        expect(scmReviewComparisonMatchesSource({ kind: 'session' }, source)).toBe(true);
    });
    it('selects the saved PR by its base-tip witness when the diff begins at a different merge base', () => {
        const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'owner/repo', number: 17,
            baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) } };
        loadSavedScmDiffSummaryResult({ sessionId: 's', scope,
            result: ScmDiffSummaryResultSchema.parse({ resultId: 'pr-result', revision: 1, canUndo: false,
                output: { success: true, resultId: 'pr-result', revision: 1, sourceKey: 'pr-comparison', metadata: { sourceKey: 'pr-comparison', source },
                    comparison: { id: 'pr-comparison', source, repository: { rootPath: '/repo' },
                        endpoints: { before: 'c'.repeat(40), after: 'b'.repeat(40) }, pullRequest: { baseOid: 'a'.repeat(40) },
                        inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
                    outputs: { walkthrough: { state: 'pending' } }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } }) });
        const scopeKey = serverAccountScopeKeySuffix(scope);
        const key = selectSessionScmWalkthroughKey(getScmDiffSummaryState(), 's', source, 'walkthrough', scopeKey);
        expect(key && getScmDiffSummaryState().entriesByKey[key]?.latestOutput?.comparison?.id).toBe('pr-comparison');
        expect(selectSessionScmWalkthroughKey(getScmDiffSummaryState(), 's', { ...source,
            locator: { ...source.locator, baseOid: 'd'.repeat(40) } }, 'walkthrough', scopeKey)).toBeNull();
    });
    it('does not reuse captured evidence for a different explicit turn mode or PR endpoint', () => {
        const checkpoint = { kind: 'turnCheckpoint' as const, turnId: 'turn-1', evidenceMode: 'checkpoint' as const };
        expect(scmReviewComparisonMatchesSource({ kind: 'turnCheckpoint', turnId: 'turn-1', evidenceMode: 'agent_reported' }, checkpoint)).toBe(false);
        const requestedView = { kind: 'turnCheckpoint' as const, turnId: 'turn-1', evidence: 'agent_reported' as const };
        expect(scmReviewComparisonMatchesSource(requestedView, checkpoint)).toBe(false);
        const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'owner/repo', number: 17 } };
        const selected = { ...source, locator: { ...source.locator, baseOid: 'wrong-base' } };
        expect(scmReviewComparisonMatchesSource(selected, { ...source, locator: { ...source.locator, baseOid: 'actual-base' } })).toBe(false);
        const captured = { endpoints: { before: 'merge-base', after: 'actual-head' }, pullRequest: { baseOid: 'actual-base' } };
        expect(scmReviewComparisonMatchesSource({ ...source, locator: { ...source.locator, baseOid: 'actual-base', headOid: 'actual-head' } }, source, captured)).toBe(true);
        expect(scmReviewComparisonMatchesSource(selected, source, captured)).toBe(false);
    });
    it('matches the exact checkpoint receipt and rejects a selector with no captured turn identity', () => {
        const source = { kind: 'turnCheckpoint' as const, checkpointReceiptId: 'receipt-1' };
        expect(scmReviewComparisonMatchesSource({ kind: 'turnCheckpoint', checkpointReceiptId: 'receipt-1' }, source)).toBe(true);
        expect(scmReviewComparisonMatchesSource({ kind: 'turnCheckpoint', checkpointReceiptId: 'receipt-2' }, source)).toBe(false);
        expect(scmReviewComparisonMatchesSource({ kind: 'turnCheckpoint' }, source)).toBe(false);
    });
    it('opens the captured result even after another result of that source is saved', () => {
        const save = (id: string) => loadSavedScmDiffSummaryResult({ sessionId: 's', scope,
            result: ScmDiffSummaryResultSchema.parse({ resultId: id, revision: 1, canUndo: false,
                output: { success: true, resultId: id, revision: 1, sourceKey: id, metadata: { sourceKey: id, source: { kind: 'session', sessionId: 's' } },
                    comparison: { id, source: { kind: 'session', sessionId: 's' }, repository: { rootPath: '/repo' }, endpoints: {},
                        inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
                    outputs: { walkthrough: { state: 'pending' } }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } }) });
        save('captured');
        save('newer');
        const key = selectSessionScmWalkthroughKey(getScmDiffSummaryState(), 's', { kind: 'session', comparisonId: 'captured' }, 'walkthrough', serverAccountScopeKeySuffix(scope));
        expect(key && getScmDiffSummaryState().entriesByKey[key]?.latestOutput?.comparison?.id).toBe('captured');
        expect(scmComparisonSourceOf({ kind: 'session', comparisonId: 'captured' }, 's')).toEqual({ kind: 'session', sessionId: 's' });
    });
});
