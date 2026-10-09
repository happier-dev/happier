import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import type { ScmDiffSummaryResult } from '@happier-dev/protocol/scm/diffSummaryResult';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildWorkspaceScmAuthoringSeed } from './workspaceScmAuthoring';

const workspace = { serverId: 'home-a', workspaceId: 'checkout-exact', machineId: 'machine-a', rootPath: '/repo' };
const scope = { serverId: workspace.serverId, accountId: 'alice' };
const comparison = ScmComparisonSchema.parse({ id: 'comparison-exact', source: { kind: 'branch', head: 'feature', base: 'main' },
    repository: { rootPath: '/repo' }, endpoints: { before: 'before-oid', after: 'after-oid' }, inventory: { state: 'complete', reasons: [], files: [
        { path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            evidence: { state: 'available', unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n@@ -10 +10 @@\n-otherBefore\n+otherAfter\n' },
            occurrences: [
                { id: 'change-one', alias: 'c1', path: 'a.ts', position: 0, before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } },
                { id: 'change-other', alias: 'c2', path: 'a.ts', position: 1, before: { startLine: 10, lineCount: 1 }, after: { startLine: 10, lineCount: 1 } },
            ] },
        { path: 'denied.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            evidence: { state: 'unavailable', reason: 'permission_denied', unifiedDiff: 'DO_NOT_DISCLOSE' }, occurrences: [] },
    ] } });
const result: ScmDiffSummaryResult = { resultId: 'saved-result', revision: 4, canUndo: false, output: {
    success: false, error: 'Partial', errorCode: 'SUMMARY_FAILED', sourceKey: comparison.id,
    comparison, resultId: 'saved-result', revision: 4,
    outputs: { walkthrough: { state: 'partial', value: { title: 'Reading', intro: 'Overview', otherChangeRefs: ['change-other'],
        stops: [{ id: 'stop-one', title: 'Saved stop', explanationMarkdown: 'Saved explanation', changeRefs: ['change-one'] }] } } },
} };
afterEach(resetSessionDraftRepositoryForTests);

describe('workspace SCM ordinary authoring seed', () => {
    it('captures the exact checkout and basis with only the selected stop authorized excerpts', () => {
        const seed = buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison, result, stopId: 'stop-one' });
        expect(seed).not.toBeNull();
        expect(seed?.prompt).toContain('before-oid');
        expect(seed?.prompt).toContain('Saved explanation');
        expect(seed?.prompt).toContain('+after');
        expect(seed?.prompt).not.toContain('+otherAfter');
        expect(seed?.prompt).not.toContain('DO_NOT_DISCLOSE');
        expect(seed).toMatchObject({ placement: { kind: 'exactTarget', serverId: workspace.serverId, machineId: workspace.machineId, directory: workspace.rootPath },
            origin: { workspace, accountId: scope.accountId, comparisonId: comparison.id, page: 'changes' } });
    });

    it('refuses retired scopes before any draft or navigation, and refuses mismatched comparison or absent stop evidence', () => {
        const seed = buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison, result });
        const navigate = vi.fn();
        expect(seedAndOpenNewSession({ seed, scope, isCurrent: () => false,
            createDraftId: () => 'stale-draft', navigateToNewSession: navigate })).toMatchObject({ kind: 'stale' });
        expect(readNewSessionDraftFromRepository({ scope, draftId: 'stale-draft' })).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
        expect(buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison, result: null, stopId: 'stop-one' })).toBeNull();
        expect(buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison: { ...comparison, id: 'different' }, result })).toBeNull();
        expect(buildWorkspaceScmAuthoringSeed({ workspace: { ...workspace, rootPath: '/other' }, accountId: scope.accountId, comparison, result })).toBeNull();
    });
});
