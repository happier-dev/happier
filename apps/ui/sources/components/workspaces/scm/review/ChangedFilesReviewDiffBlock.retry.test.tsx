import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { createThemeFixture, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { ChangedFilesReview } = await import('./ChangedFilesReview');
const { useChangedFilesReviewDiffLoading } = await import('./useChangedFilesReviewDiffLoading');
const { useChangedFilesReviewDiffBlockRenderer } = await import('./useChangedFilesReviewDiffBlockRenderer');
const { readCapturedScmFileForSession } = await import('@/sync/ops/scmDiffSummary/generate');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); fixture = undefined; });
const files = ['a.ts', 'b.ts'].map(path => scmFileStatusFromChange({ path, changeKind: 'modified', added: 1, removed: 1 }));
const patch = (value: string) => `@@ -1 +1 @@\n-old\n+${value}\n`;

function reader(current: NonNullable<typeof fixture>) {
    return async ({ path }: Readonly<{ path: string }>) => {
        const response = await readCapturedScmFileForSession({ machineId: current.scope.machineId,
            scope: { serverId: current.scope.serverId, accountId: 'alice' }, input: {
                cwd: current.scope.rootPath, comparisonId: 'c'.repeat(64), source: { kind: 'session', sessionId: 's1' }, path,
            } });
        return response.success ? { success: true as const, diff: response.diff ?? '' }
            : { success: false as const, error: response.error ?? 'Captured diff unavailable' };
    };
}

describe('Review diff recovery', () => {
    it.each(['typed failure', 'rejected transport'] as const)('retries only the failed file after a %s', async (failure) => {
        const reads: string[] = [];
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method !== RPC_METHODS.SCM_DIFF_FILE) return undefined;
            // This socket boundary receives the captured-file wire request.
            const { captured: { path } } = request.payload as { captured: { path: string } };
            reads.push(path);
            if (path === 'a.ts' && reads.filter(item => item === path).length === 1) {
                if (failure === 'rejected transport') throw new RpcError('RPC_OUTCOME_UNKNOWN', 'Machine disconnected during the captured diff read');
                return { success: false, error: 'Captured diff could not be read', errorCode: 'COMMAND_FAILED' };
            }
            return { success: true, diff: patch(`recovered ${path}`) };
        } });
        const screen = await fixture.render(<ChangedFilesReview sessionId="s1" workspaceScope={fixture.scope}
            theme={createThemeFixture()} snapshot={fileViewSnapshot()} changedFilesViewMode="repository"
            allRepositoryChangedFiles={files} sessionAttributedFiles={[]} repositoryOnlyFiles={[]}
            maxFiles={25} maxChangedLines={2000} initialCollapsedPaths={['b.ts']}
            onFilePress={() => {}} fetchUnifiedDiffForPath={reader(fixture)} />);
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        await vi.waitFor(() => expect(screen.tree.root.findAllByType(SurfaceStateCard)
            .some(node => node.props.kind === 'error')).toBe(true));
        expect(reads.filter(path => path === 'a.ts')).toHaveLength(1);
        await screen.pressByTestIdAsync('scm-review-diff-a.ts-error-action');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('recovered a.ts'));
        expect(reads.filter(path => path === 'a.ts')).toHaveLength(2);
        expect(reads.filter(path => path === 'b.ts')).toHaveLength(0);
        expect(screen.tree.root.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'error')).toBe(false);
    });

    it('retains the loaded patch with freshness and Retry when its refresh fails', async () => {
        let reads = 0;
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method !== RPC_METHODS.SCM_DIFF_FILE) return undefined;
            reads++;
            return reads === 2 ? { success: false, error: 'Captured diff refresh failed', errorCode: 'COMMAND_FAILED' }
                : { success: true, diff: patch('last known content') };
        } });
        const fetchUnifiedDiffForPath = reader(fixture);
        let refreshToken = 0;
        function Review() {
            const loading = useChangedFilesReviewDiffLoading({ sessionId: 's1', isRepo: true, reviewFiles: files,
                diffArea: 'pending', requestedPaths: ['a.ts'], tooLarge: false, selectedPath: 'a.ts',
                snapshotSignature: 'retained-capture', refreshToken, fetchUnifiedDiffForPath,
                normalizeError: String, fallbackError: 'Unable to read captured diff' });
            const render = useChangedFilesReviewDiffBlockRenderer({ theme: createThemeFixture(), sessionId: 's1',
                diffStateSource: loading.diffStateSource, onRetryDiff: loading.retryDiff });
            return render('a.ts', { snapshotSignature: 'retained-capture' });
        }
        const screen = await fixture.render(<Review />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('last known content'));
        refreshToken++;
        await screen.update(fixture.wrap(<Review />));
        await vi.waitFor(() => expect(screen.tree.root.findAllByType(SurfaceFreshnessLine)).toHaveLength(1));
        expect(screen.getTextContent()).toContain('last known content');
        expect(screen.getTextContent()).toContain('Captured diff refresh failed');
        expect(reads).toBe(2);
        await screen.pressByTestIdAsync('scm-review-diff-a.ts-freshness-action');
        await vi.waitFor(() => expect(screen.tree.root.findAllByType(SurfaceFreshnessLine)).toHaveLength(0));
        expect(screen.getTextContent()).toContain('last known content');
        expect(reads).toBe(3);
    });
});
