import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { standardCleanup } from '@/dev/testkit';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import {
    createSessionFilesViewFixture,
    installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit,
    type FileViewRpcRequest,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

// The captured incident is a phone browser route, including its web rendering boundary.
installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { FileChangesSection } = await import('../file/changes/FileChangesRegions');
const { FilePageHeader } = await import('../file/FilePageHeader');
const { readActiveFileViewActionOwner } = await import('@/sync/ops/actions/scopeActionFamily');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); });

describe('captured File evidence page', () => {
    it('retains the opened Review round comments and finding when a captured file is pushed and cold-mounted', async () => {
        const reviewId = '4b71ce6d-eb04-49cc-89e4-fd2d139586ed';
        const comment = buildReviewCommentFixture({ id: 'saved-gutter', reviewId, accountId: 'alice', roundOrdinal: 1,
            author: { kind: 'user', userId: 'alice' }, anchor: { kind: 'line', filePath: 'totals.py', line: 2, side: 'after' },
            body: 'Retain every price in this total.', snapshot: { kind: 'none', capturedAt: 1 } });
        const finding = buildReviewCommentFixture({ id: 'saved-finding', reviewId, accountId: 'alice', roundOrdinal: 1,
            anchor: { kind: 'line', filePath: 'totals.py', line: 2, side: 'after' },
            finding: { id: 'total-finding', title: 'Include every price', summary: 'The last price is dropped.', severity: 'high', category: 'correctness' },
            findingSeverity: 'high', snapshot: { kind: 'none', capturedAt: 1 } });
        const otherRound = buildReviewCommentFixture({ id: 'other-round', reviewId, accountId: 'alice', roundOrdinal: 2,
            anchor: comment.anchor, body: 'A different round note', snapshot: { kind: 'none', capturedAt: 1 } });
        const comparison = ScmComparisonSchema.parse({ id: '2f626e07145550b193b3996ee0bb3c98a2db2bdd4916966b2fe1f87c52545c56',
            source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
            inventory: { state: 'complete', reasons: [], files: [{ path: 'totals.py', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                occurrences: [{ id: 'total-change', alias: 'total-change', path: 'totals.py', position: 0, before: { startLine: 2, lineCount: 1 }, after: { startLine: 2, lineCount: 1 } }],
                evidence: { state: 'available', unifiedDiff: '@@ -1,2 +1,2 @@\n def total(prices):\n-    return sum(prices)\n+    return sum(prices[:-1])\n' } }] } });
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', request: async url => {
            if (new URL(String(url)).pathname === '/v1/reviews/comments') return Response.json({
                items: [comment, finding, otherRound].map(storePlainReviewCommentFixture), cursor: null });
            return Response.json({}, { status: 404 });
        }, rpc: request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE ? {
            success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } } : undefined });
        const context = await captureLazyActionAccountContext(fixture.scope.serverId);
        const records = createReviewRecordPortV1(context.homeHubArtifactTransport);
        const round = await records.start({ reviewId, title: 'Captured phone Review', subjectKind: 'comparison',
            sourceKind: 'direct', reviewerIds: [], startedAt: 1 });
        await records.settle({ ...round, outcome: 'completed', finishedAt: 2, runs: [] });
        const page = <SurfaceStateSizeProvider size="phone"><WorkspaceFileDetailsView scopeId="captured-file:review-context"
            scope={fixture.scope} filePath="totals.py" initialChanges={{ kind: 'workingTree', comparisonId: comparison.id }}
            initialView={{ view: 'changes' }} evidenceOnly review={{ reviewId, roundOrdinal: 1 }} /></SurfaceStateSizeProvider>;
        const screen = await fixture.render(page);
        await vi.waitFor(() => expect(screen.getTextContent().replace(/\s/g, '')).toContain('returnsum(prices[:-1])'));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(comment.body));
        expect(screen.getTextContent()).toContain('Include every price');
        expect(screen.getTextContent()).not.toContain('A different round note');
        await screen.unmount();
        const cold = await fixture.render(page);
        await vi.waitFor(() => expect(cold.getTextContent()).toContain(comment.body));
        expect(cold.getTextContent()).toContain('Include every price');
    });

    it('keeps the exact captured working-tree comparison readable without live file reads or mutation controls', async () => {
        const requests: FileViewRpcRequest[] = [];
        const comparison = ScmComparisonSchema.parse({ id: 'e'.repeat(64), source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [
                { path: 'source.txt', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                    occurrences: [{ id: 'evidence-hunk', alias: 'evidence-hunk', path: 'source.txt', position: 0, layer: 'combined',
                        before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
                    evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+captured-evidence\n' } },
            ] } });
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', settings: { featureToggles: { 'files.editor': true } }, rpc: request => {
            requests.push(request);
            if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return {
                success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source },
            };
            if (request.method === 'daemon.filesystem.readFile') return {
                success: true, content: Buffer.from('live-working-copy\n').toString('base64'),
            };
            if (request.method === RPC_METHODS.SCM_DIFF_FILE) return { success: true, diff: '@@ -1 +1 @@\n-old\n+live-working-copy\n' };
            return { success: true, exists: true, kind: 'file', sizeBytes: 18 };
        } });
        const screen = await fixture.render(<SurfaceStateSizeProvider size="phone">
            <WorkspaceFileDetailsView scopeId="captured-file:evidence" scope={fixture.scope} filePath="source.txt"
                initialChanges={{ kind: 'workingTree', comparisonId: comparison.id }}
                initialView={{ view: 'changes' }} evidenceOnly />
        </SurfaceStateSizeProvider>);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('captured-evidence'));
        expect(screen.findAllByType(FileChangesSection)).toHaveLength(1);
        expect(requests.find(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)?.payload).toMatchObject({
            comparisonId: comparison.id,
        });
        expect(requests.filter(request => request.method === 'daemon.filesystem.readFile' || request.method === RPC_METHODS.SCM_DIFF_FILE)).toHaveLength(0);
        const header = screen.findAllByType(FilePageHeader)[0]!;
        expect(header.props.displayMode).toBe('diff');
        expect(header.props.modes.map((mode: { id: string }) => mode.id)).toEqual(['changes']);
        expect(header.props.edit).toBeNull();
        expect(header.props.scmWriteEnabled).toBe(false);
        expect(header.props.menuActions.map((action: { id: string }) => action.id)).not.toContain('discard');
        expect(header.props.menuActions.map((action: { id: string }) => action.id)).not.toContain('restoreBeforeTurn');
        expect(header.props.menuActions.map((action: { id: string }) => action.id)).not.toContain('download');
        expect(header.props.menuActions.map((action: { id: string }) => action.id)).not.toContain('copyLink');
        expect(screen.findAllByType(FileChangesSection)[0]!.props.review.scopeTabs).toEqual([]);
        const owner = readActiveFileViewActionOwner();
        expect(owner?.availableModes).toEqual(['changes']);
        expect(owner?.changesScopeAvailable).toBe(false);
        let switched: boolean | undefined;
        await act(async () => { switched = await owner?.set({ mode: 'view' }); });
        expect(switched).toBe(false);
        expect(screen.findAllByType(FilePageHeader)[0]!.props.displayMode).toBe('diff');
    });
});
