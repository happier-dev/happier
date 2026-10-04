import { describe, expect, it } from 'vitest';
import type { ScmCommitPlanApplication, ScmComparison, ScmDiffSummaryCommitPlan } from '@happier-dev/protocol';

import { buildCommitProposal } from './commitProposal';
import { buildCommitPlanAcceptance } from './commitPlanAcceptance';

const A_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' import x from "x";',
    '+import y from "y";',
    ' const a = 1;',
    '@@ -20,3 +21,3 @@ export function a() {',
    '-    return key;',
    '+    return key + 1;',
    ' }',
].join('\n');
const B_DIFF = ['diff --git a/src/b.ts b/src/b.ts', '--- /dev/null', '+++ b/src/b.ts', '@@ -0,0 +1,2 @@', '+export const b = 1;', '+export const c = 2;'].join('\n');
const LOCK_DIFF = ['diff --git a/yarn.lock b/yarn.lock', '--- a/yarn.lock', '+++ b/yarn.lock', '@@ -10,1 +10,1 @@', '-"x@1": 1', '+"x@2": 2'].join('\n');

const range = (startLine: number, lineCount: number) => ({ startLine, lineCount });
const HEAD = 'a'.repeat(40);
const LANDED = 'b'.repeat(40);
const COMPARISON: ScmComparison = {
    id: 'pending-1',
    source: { kind: 'workingTree' },
    repository: { rootPath: '/repo' },
    endpoints: { before: HEAD },
    commitTarget: { headOid: HEAD, ref: 'refs/heads/main' },
    inventory: {
        state: 'complete',
        reasons: [],
        files: [
            { path: 'src/a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: A_DIFF },
                occurrences: [
                    { id: 'a#0', alias: 'c1', path: 'src/a.ts', before: range(1, 3), after: range(1, 4), position: 0 },
                    { id: 'a#1', alias: 'c2', path: 'src/a.ts', before: range(20, 3), after: range(21, 3), position: 1 },
                ] },
            { path: 'src/b.ts', changeKind: 'added', binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: B_DIFF },
                occurrences: [{ id: 'b#0', alias: 'c3', path: 'src/b.ts', before: range(0, 0), after: range(1, 2), position: 0 }] },
            { path: 'yarn.lock', changeKind: 'modified', binary: false, generated: false, lockfile: true, evidence: { state: 'available', unifiedDiff: LOCK_DIFF },
                occurrences: [{ id: 'lock#0', alias: 'c4', path: 'yarn.lock', before: range(10, 1), after: range(10, 1), position: 0 }] },
        ],
    },
};
const PLAN: ScmDiffSummaryCommitPlan = {
    groups: [
        { id: 'g1', message: 'Import y', rationale: 'The dependency first.', changeRefs: ['a#0', 'b#0'] },
        { id: 'g2', message: 'Return the next key', rationale: 'The fix.', changeRefs: ['a#1'] },
    ],
    leftOutChangeRefs: ['lock#0'],
};

function application(patch: Partial<ScmCommitPlanApplication>): ScmCommitPlanApplication {
    return {
        acceptedRevision: 3,
        acceptance: { comparisonId: 'pending-1', repositoryRootPath: '/repo', expectedHeadOid: HEAD, expectedRef: 'refs/heads/main', ...PLAN },
        status: 'applying',
        steps: [{ groupId: 'g1', state: 'writing' }, { groupId: 'g2', state: 'pending' }],
        nextGroupIndex: 0,
        stopAfterCurrent: false,
        ...patch,
    };
}

describe('buildCommitProposal', () => {
    it('lists each group by exact occurrence: a split file says which part belongs, totals count files once', () => {
        const proposal = buildCommitProposal({ comparison: COMPARISON, plan: PLAN, application: null });
        expect(proposal.groups.map((group) => group.changes.map((change) => [change.path, change.part, change.added, change.removed]))).toEqual([
            [['src/a.ts', { count: 1, of: 2 }, 1, 0], ['src/b.ts', null, 2, 0]],
            [['src/a.ts', { count: 1, of: 2 }, 1, 1]],
        ]);
        expect(proposal.leftOut.map((change) => [change.path, change.lockfile])).toEqual([['yarn.lock', true]]);
        expect({ committed: proposal.committedFileCount, total: proposal.totalFileCount }).toEqual({ committed: 2, total: 3 });
        expect(proposal.groups.every((group) => group.state === 'editable')).toBe(true);
        expect(proposal.outcome).toBeNull();
        expect(proposal.locked).toBe(false);
    });

    it('locks every group while applying and reports per-commit state', () => {
        const proposal = buildCommitProposal({ comparison: COMPARISON, plan: PLAN, application: application({
            steps: [{ groupId: 'g1', state: 'published', commitSha: LANDED, actualMessage: 'Import y\n\nRefs: HAP-1' }, { groupId: 'g2', state: 'writing' }],
            nextGroupIndex: 1,
        }) });
        expect(proposal.locked).toBe(true);
        expect(proposal.groups.map((group) => group.state)).toEqual(['landed', 'writing']);
        expect(proposal.groups[0]).toMatchObject({ landedSha: LANDED, rewrittenMessage: 'Import y\n\nRefs: HAP-1' });
        expect(proposal.landedCount).toBe(1);
    });

    it('a hook that changed files pauses that commit and names exactly the paths it touched', () => {
        const proposal = buildCommitProposal({ comparison: COMPARISON, plan: PLAN, application: application({
            status: 'paused', reason: 'hook_content_changed', nextGroupIndex: 1,
            steps: [{ groupId: 'g1', state: 'published', commitSha: LANDED }, { groupId: 'g2', state: 'not_published',
                hookContentChanges: { beforeTreeOid: 'c'.repeat(40), afterTreeOid: 'd'.repeat(40), changes: [{ path: 'src/a.ts', kind: 'modified' }, { path: 'src/new.ts', kind: 'added' }] } }],
        }) });
        expect(proposal.locked).toBe(true);
        expect(proposal.groups.map((group) => group.state)).toEqual(['landed', 'paused']);
        expect(proposal.outcome).toEqual({ kind: 'hookChanged', groupId: 'g2', hookName: null, paths: ['src/a.ts', 'src/new.ts'],
            beforeTreeOid: 'c'.repeat(40), afterTreeOid: 'd'.repeat(40), landedCount: 1 });
        expect(proposal.groups[1]!.changes.find((change) => change.path === 'src/a.ts')?.hookChanged).toBe(true);
    });

    it.each([
        ['signing_failed', 'failed', 'signing'],
        ['hook_failed', 'failed', 'hookFailed'],
        ['head_moved', 'failed', 'headMoved'],
        ['outcome_unknown', 'unknown', 'unknown'],
        ['staging_conflict', 'failed', 'failed'],
        ['stopped', 'stopped', 'stopped'],
    ] as const)('%s becomes one typed outcome line, and the rest stay editable once nothing is applying', (reason, status, kind) => {
        const proposal = buildCommitProposal({ comparison: COMPARISON, plan: PLAN, application: application({
            status, reason, nextGroupIndex: 1,
            steps: [{ groupId: 'g1', state: 'published', commitSha: LANDED }, { groupId: 'g2', state: status === 'unknown' ? 'unknown' : 'not_published', error: 'eslint: 1 error' }],
        }) });
        expect(proposal.outcome?.kind).toBe(kind);
        expect(proposal.groups[0]!.state).toBe('landed');
        expect(proposal.locked).toBe(status === 'unknown');
        if (kind === 'hookFailed') expect(proposal.outcome).toMatchObject({ groupId: 'g2', output: 'eslint: 1 error' });
        if (kind === 'headMoved' || kind === 'stopped') expect(proposal.outcome).toMatchObject({ landedCount: 1, remainingCount: 1 });
    });
});

describe('writer facts on each commit (lab WT4-C3/C4)', () => {
    it('names the hook that stopped or expanded a commit, and carries a landed commit\'s time and signing', () => {
        const publication = (patch: Record<string, unknown>) => ({ state: 'not_published' as const, expectedHeadOid: HEAD, expectedRef: 'refs/heads/main', indexReconciliation: 'not_required' as const, ...patch });
        const failed = buildCommitProposal({ comparison: COMPARISON, plan: PLAN, application: application({
            status: 'failed', reason: 'hook_failed', nextGroupIndex: 1,
            steps: [{ groupId: 'g1', state: 'published', commitSha: LANDED, publication: { ...publication({ committedAtMs: 1_700_000_000_000, signed: true }), state: 'published', candidateOid: LANDED } },
                { groupId: 'g2', state: 'not_published', error: 'lint failed', publication: publication({ hookName: 'commit-msg' }) }],
        }) });
        expect(failed.outcome).toMatchObject({ kind: 'hookFailed', hookName: 'commit-msg', output: 'lint failed' });
        expect(failed.groups[0]).toMatchObject({ committedAtMs: 1_700_000_000_000, signed: true });
        expect(failed.groups[1]).toMatchObject({ committedAtMs: null, signed: false });
        const paused = buildCommitProposal({ comparison: COMPARISON, plan: PLAN, application: application({
            status: 'paused', reason: 'hook_content_changed', nextGroupIndex: 0,
            steps: [{ groupId: 'g1', state: 'not_published', publication: publication({ hookName: 'pre-commit' }),
                hookContentChanges: { beforeTreeOid: 'c'.repeat(40), afterTreeOid: 'd'.repeat(40), changes: [{ path: 'src/a.ts', kind: 'modified' }] } }, { groupId: 'g2', state: 'pending' }],
        }) });
        expect(paused.outcome).toMatchObject({ kind: 'hookChanged', hookName: 'pre-commit' });
    });
});

describe('buildCommitPlanAcceptance', () => {
    it('binds the captured parent, branch ref, exact groups and left-out changes', () => {
        expect(buildCommitPlanAcceptance({ comparison: COMPARISON, plan: PLAN, application: null })).toEqual({
            comparisonId: 'pending-1', repositoryRootPath: '/repo', expectedHeadOid: HEAD, expectedRef: 'refs/heads/main',
            groups: PLAN.groups, leftOutChangeRefs: ['lock#0'],
        });
        expect(buildCommitPlanAcceptance({ comparison: { ...COMPARISON, commitTarget: { headOid: HEAD, ref: null } }, plan: PLAN, application: null })?.expectedRef).toBeNull();
    });

    it('renewed acceptance continues from the landed commit and binds only what is left', () => {
        const acceptance = buildCommitPlanAcceptance({ comparison: COMPARISON, plan: PLAN, application: application({
            status: 'failed', reason: 'hook_failed', nextGroupIndex: 1,
            steps: [{ groupId: 'g1', state: 'published', commitSha: LANDED }, { groupId: 'g2', state: 'not_published' }],
        }) });
        expect(acceptance).toMatchObject({ expectedHeadOid: LANDED, groups: [PLAN.groups[1]] });
    });

    it('refuses an empty group, a history comparison and an application that is still running', () => {
        expect(buildCommitPlanAcceptance({ comparison: { ...COMPARISON, commitTarget: undefined }, plan: PLAN, application: null })).toBeNull();
        expect(buildCommitPlanAcceptance({ comparison: COMPARISON, application: null,
            plan: { ...PLAN, groups: [...PLAN.groups, { id: 'g3', message: 'Empty', rationale: '', changeRefs: [] }] } })).toBeNull();
        expect(buildCommitPlanAcceptance({ comparison: { ...COMPARISON, source: { kind: 'session', sessionId: 's' } }, plan: PLAN, application: null })).toBeNull();
        expect(buildCommitPlanAcceptance({ comparison: COMPARISON, plan: PLAN, application: application({}) })).toBeNull();
    });
});
