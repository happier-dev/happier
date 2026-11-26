import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { standardCleanup } from '@/dev/testkit';
import {
    createSessionFilesViewFixture,
    installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit,
    type FileViewRpcRequest,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { FileChangesSection } = await import('../file/changes/FileChangesRegions');
const { FilePageHeader } = await import('../file/FilePageHeader');
const { readActiveFileViewActionOwner } = await import('@/sync/ops/actions/scopeActionFamily');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); });

describe('captured File evidence page', () => {
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
