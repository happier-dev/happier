import { describe, expect, it, vi } from 'vitest';
import type { ScmComparison, ScmDiffSummaryCommitPlan } from '@happier-dev/protocol';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

const { buildCommitProposal } = await import('./commitProposal');
const { buildCommitHookFixPrompt } = await import('./commitHookFixPrompt');

const COMPARISON: ScmComparison = {
    id: 'pending', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
    inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-a\n+b' },
        occurrences: [{ id: 'a#0', alias: 'c1', path: 'a.ts', before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 }, position: 0 }] }] },
};
const PLAN: ScmDiffSummaryCommitPlan = { groups: [{ id: 'g1', message: 'Fix a', rationale: '', changeRefs: ['a#0'] }], leftOutChangeRefs: [] };

describe('buildCommitHookFixPrompt (lab WT4-C4 "Ask this session to fix it")', () => {
    it('asks the Session to fix exactly what the named hook reported for that commit', () => {
        const proposal = buildCommitProposal({ comparison: COMPARISON, plan: PLAN, application: {
            acceptedRevision: 1, acceptance: { comparisonId: 'pending', repositoryRootPath: '/repo', expectedHeadOid: null, expectedRef: 'refs/heads/main', ...PLAN },
            status: 'failed', reason: 'hook_failed', nextGroupIndex: 0, stopAfterCurrent: false,
            steps: [{ groupId: 'g1', state: 'not_published', error: 'a.ts:1 unused export\n',
                publication: { state: 'not_published', expectedHeadOid: null, expectedRef: 'refs/heads/main', indexReconciliation: 'not_required', hookName: 'pre-commit' } }],
        } });
        const prompt = buildCommitHookFixPrompt(proposal);
        expect(prompt).toContain('commitProposal.askFix:{"hook":"pre-commit","number":1,"message":"Fix a"}');
        expect(prompt).toContain('a.ts:1 unused export');
        expect(buildCommitHookFixPrompt(buildCommitProposal({ comparison: COMPARISON, plan: PLAN, application: null }))).toBeNull();
    });
});
