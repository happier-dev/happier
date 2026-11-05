import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';

import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { FileChangesReview } from './useFileChangesReview';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { useFileChangesReview } = await import('./useFileChangesReview');
const { FileChangesBody } = await import('./FileChangesRegions');
const { useCapturedScmComparison } = await import('@/components/sessions/files/comparison/useCapturedScmComparison');
const { CapturedComparisonFilesView } = await import('@/components/sessions/files/comparison/CapturedComparisonFilesView');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); });

const comparison = ScmComparisonSchema.parse({ id: 'c'.repeat(64), source: { kind: 'session', sessionId: 's1' },
    repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [
        { path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            occurrences: [{ id: 'a-hunk', alias: 'a-hunk', path: 'a.ts', position: 0, layer: 'combined',
                before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
            evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' } },
    ] } });

function fileAtPath(path: string) {
    const file = comparison.inventory.files[0]!;
    return path === file.path ? file : { ...file, path, occurrences: file.occurrences.map(occurrence => ({
        ...occurrence, path, id: `${path}:${occurrence.id}`, alias: `${path}:${occurrence.alias}`,
    })) };
}

describe('File changes dependency settlement', () => {
    it('retains Review content with an explicit Retry after an index refresh fails', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo' });
        let retries = 0;
        function Probe() {
            const [error, setError] = React.useState<string | null>('RPC target disconnected after request submission');
            return <CapturedComparisonFilesView comparison={comparison} maxFiles={25} maxChangedLines={2000}
                error={error} onRefresh={() => { retries++; setError(null); }} />;
        }
        const screen = await fixture.render(<Probe />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('new'));
        expect(screen.findByTestId('captured-comparison-refresh-error')).not.toBeNull();
        await screen.pressByTestIdAsync('captured-comparison-refresh-error-action');
        expect(retries).toBe(1);
        expect(screen.findByTestId('captured-comparison-refresh-error')).toBeNull();
        expect(screen.getTextContent()).toContain('new');
    });
    it('retains an expanded pinned Review diff when the responsive presenter remounts offline', async () => {
        const opened: unknown[] = [];
        let offline = false;
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method !== RPC_METHODS.SCM_DIFF_FILE) return undefined;
            opened.push(request.payload);
            if (offline) throw new RpcError('RPC target disconnected after request submission', 'RPC_OUTCOME_UNKNOWN');
            return { success: true, diff: comparison.inventory.files[0]!.evidence.unifiedDiff,
                capturedFile: comparison.inventory.files[0] };
        } });
        const index = ScmComparisonSchema.parse({ ...comparison, inventory: { ...comparison.inventory,
            files: ['a.ts', 'b.ts'].map(path => ({ ...fileAtPath(path),
                linesAdded: 1, linesRemoved: 1, evidence: { state: 'deferred', reason: 'Read the captured file diff' } })) } });
        const scope = fixture.scope;
        let replacePresenter!: () => void;
        function Probe() {
            const [layout, setLayout] = React.useState(0);
            replacePresenter = () => setLayout(value => value + 1);
            return <CapturedComparisonFilesView key={layout} comparison={index} sessionId="s1"
                workspaceScope={scope} initialCollapsedPaths={['b.ts']} maxFiles={25} maxChangedLines={2000} />;
        }
        const screen = await fixture.render(<Probe />);
        await vi.waitFor(() => expect(opened, screen.getTextContent()).toHaveLength(1));
        expect(opened[0]).toMatchObject({ cwd: '/repo', captured: { comparisonId: comparison.id, path: 'a.ts' } });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('new'));
        offline = true;
        await act(async () => replacePresenter());
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('new'));
        expect(opened).toHaveLength(1);
    });
    it('reads continuation only on request and pins it to the retained comparison', async () => {
        const requests: unknown[] = [];
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method !== RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return undefined;
            requests.push(request.payload);
            const next = requests.length > 1;
            return { success: true, comparison: { ...comparison, inventory: { ...comparison.inventory,
                files: next ? [fileAtPath('b.ts')] : comparison.inventory.files } },
                metadata: { sourceKey: comparison.id, source: comparison.source },
                page: { totalFiles: 2, nextCursor: next ? null : 1 } };
        } });
        const currentFixture = fixture;
        let capture!: ReturnType<typeof useCapturedScmComparison>;
        let pin!: () => void;
        function Probe() {
            const [comparisonId, setComparisonId] = React.useState<string>();
            pin = () => setComparisonId(comparison.id);
            capture = useCapturedScmComparison({ host: { sessionId: 's1' }, serverId: currentFixture.scope.serverId,
                machine: { machineId: 'm1', basePath: '/repo' }, identity: { machineId: 'm1', basePath: '/repo' },
                comparison: { kind: 'session', ...(comparisonId ? { comparisonId } : {}) } });
            return null;
        }
        await fixture.render(<Probe />);
        await vi.waitFor(() => expect(capture.comparison).not.toBeNull());
        expect(requests).toHaveLength(1);
        expect(capture.page).toMatchObject({ totalFiles: 2, nextCursor: 1 });
        await act(async () => pin());
        expect(capture.page).toMatchObject({ totalFiles: 2, nextCursor: 1 });
        await act(async () => capture.loadMore());
        await vi.waitFor(() => expect(capture.comparison?.inventory.files.map(file => file.path)).toEqual(['a.ts', 'b.ts']));
        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({ comparisonId: comparison.id, projection: { kind: 'index', cursor: 1 } });
        expect(capture.page?.nextCursor).toBeNull();
    });
    it('requests an index for only the opened file, then reads its pinned diff', async () => {
        const requests: { method: string; payload: unknown }[] = [];
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            requests.push(request);
            if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return {
                success: true, comparison: { ...comparison, inventory: { ...comparison.inventory,
                    files: comparison.inventory.files.map(file => ({ ...file,
                        evidence: { state: 'deferred', reason: 'Read the captured file diff' } })) } },
                metadata: { sourceKey: comparison.id, source: comparison.source },
                page: { totalFiles: 14_592, nextCursor: null },
            };
            if (request.method === RPC_METHODS.SCM_DIFF_FILE) return {
                success: true, diff: comparison.inventory.files[0]!.evidence.unifiedDiff,
                capturedFile: comparison.inventory.files[0],
            };
            return undefined;
        } });
        const currentFixture = fixture;
        let review: FileChangesReview | undefined;
        function Probe() {
            review = useFileChangesReview({ scope: currentFixture.scope, sessionId: 's1', filePath: 'a.ts',
                liveDiff: null, refreshLiveDiff: () => {}, onChangesScopeChange: () => {}, active: true });
            return null;
        }
        await fixture.render(<Probe />);
        await vi.waitFor(() => expect(requests.some(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toBe(true));
        expect(requests.find(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)?.payload).toMatchObject({
            projection: { kind: 'index', path: '/repo/a.ts' },
        });
        await vi.waitFor(() => expect(review?.status).toBe('ready'));
        expect(requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_FILE)).toMatchObject([
            { payload: { cwd: '/repo', captured: { comparisonId: comparison.id, source: comparison.source, path: 'a.ts' } } },
        ]);
        expect(review?.unifiedDiff).toContain('+new');
    });
    it.each(['RPC_OUTCOME_UNKNOWN', 'FORBIDDEN'])('settles capture failure %s and retries once through the real capture owner', async errorCode => {
        const pending = createDeferred<void>();
        let captures = 0;
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: async request => {
            if (request.method !== RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return undefined;
            captures += 1;
            if (captures === 1) {
                await pending.promise;
                throw new RpcError('RPC target disconnected after request submission', errorCode);
            }
            return { success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } };
        } });
        const currentFixture = fixture;
        function Probe() {
            const review = useFileChangesReview({ scope: currentFixture.scope, sessionId: 's1', filePath: 'a.ts',
                liveDiff: null, refreshLiveDiff: () => {}, onChangesScopeChange: () => {}, active: true });
            return <FileChangesBody review={review} keyboardActive={false}>{() => <React.Fragment>retained-diff</React.Fragment>}</FileChangesBody>;
        }
        const screen = await fixture.render(<Probe />);
        await vi.waitFor(() => expect(captures).toBe(1));
        expect(screen.findByTestId('file-changes-loading')).not.toBeNull();
        await act(async () => pending.resolve());
        await vi.waitFor(() => expect(screen.findByTestId('file-changes-error')).not.toBeNull());
        expect(screen.findByTestId('file-changes-loading')).toBeNull();
        await screen.pressByTestIdAsync('file-changes-error-action');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('retained-diff'));
        expect(captures).toBe(2);
    });

    it.each([
        ['Source control command failed', 'error', 'a.ts'],
        ['Source control command failed', 'error', 'logo.svg'],
        [null, 'empty', 'a.ts'],
    ] as const)('settles a live diff with error %s as %s for %s', async (error, state, filePath) => {
        fixture = await createSessionFilesViewFixture();
        const currentFixture = fixture;
        function Probe() {
            const review = useFileChangesReview({ scope: currentFixture.scope, filePath, liveDiff: null,
                liveDiffError: error, liveDiffLoading: false,
                refreshLiveDiff: () => {}, onChangesScopeChange: () => {}, active: true });
            return <FileChangesBody review={review} keyboardActive={false}
                image={filePath.endsWith('.svg') ? { scope: currentFixture.scope, filePath } : null}>{() => null}</FileChangesBody>;
        }
        const screen = await fixture.render(<Probe />);
        expect(screen.findByTestId(`file-changes-${state}`)).not.toBeNull();
        expect(screen.findByTestId('file-changes-loading')).toBeNull();
    });

    it('keeps captured file-details content and Retry across a remount after its refresh fails', async () => {
        let captures = 0;
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
            if (request.method !== RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return undefined;
            captures += 1;
            if (captures === 2) throw new RpcError('RPC target disconnected after request submission', 'RPC_OUTCOME_UNKNOWN');
            return { success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } };
        } });
        const currentFixture = fixture;
        let review!: FileChangesReview;
        let replaceDetails!: () => void;
        function Probe() {
            review = useFileChangesReview({ scope: currentFixture.scope, sessionId: 's1', filePath: 'a.ts',
                liveDiff: null, refreshLiveDiff: () => {}, onChangesScopeChange: () => {}, active: true });
            return <FileChangesBody review={review} keyboardActive={false}>{() => <>retained-diff</>}</FileChangesBody>;
        }
        function Owner() {
            const [layout, setLayout] = React.useState(0);
            replaceDetails = () => setLayout(value => value + 1);
            return <Probe key={layout} />;
        }
        const screen = await fixture.render(<Owner />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('retained-diff'));
        await act(async () => review.refresh());
        await vi.waitFor(() => expect(review.error).not.toBeNull());
        await act(async () => replaceDetails());
        await vi.waitFor(() => expect(screen.findByTestId('file-changes-stale')).not.toBeNull());
        expect(captures).toBe(2);
        expect(screen.findByTestId('file-changes-stale')).not.toBeNull();
        expect(screen.getTextContent()).toContain('retained-diff');
        expect(screen.findByTestId('file-changes-loading')).toBeNull();
        await screen.pressByTestIdAsync('file-changes-stale-action');
        await vi.waitFor(() => expect(screen.findByTestId('file-changes-stale')).toBeNull());
        expect(captures).toBe(3);
        expect(screen.getTextContent()).toContain('retained-diff');
    });
});
