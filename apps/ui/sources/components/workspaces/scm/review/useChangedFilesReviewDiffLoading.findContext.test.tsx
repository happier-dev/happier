import * as React from 'react';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
import { createChangedFilesReviewFind } from './useChangedFilesReviewFind';
import { fetchWorkspaceUnifiedDiffForPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import { ScmComparisonFileSchema } from '@happier-dev/protocol/scm';
import type { FindStatus } from '@happier-dev/plugin-ui/presentation';

const scm = vi.hoisted(() => ({ read: vi.fn(), diff: vi.fn() }));
// The exact-Machine SCM transport is external; revision validation, loader,
// parser and Find all remain real beneath it.
vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmFileRead: (...args: unknown[]) => scm.read(...args),
    machineScmDiffFile: (...args: unknown[]) => scm.diff(...args),
}));
await import('@/scm/files/fetchWorkspaceFileAtRevision');
afterEach(() => { standardCleanup(); vi.clearAllMocks(); });

const baseText = Array.from({ length: 30 }, (_, i) => `coast ${i === 15 ? 'hidden cedar' : i}`).join('\n') + '\n';
const diff = '@@ -2,3 +2,3 @@\n coast 1\n-coast 2\n+changed 2\n coast 3\n@@ -27,3 +27,3 @@\n coast 26\n-coast 27\n+changed 27\n coast 28\n';
const files: ScmFileStatus[] = [{ fullPath: 'coast.ts', fileName: 'coast.ts', filePath: '', status: 'modified',
    isIncluded: false, linesAdded: 2, linesRemoved: 2 }];
const renamedFiles: ScmFileStatus[] = [{ ...files[0]!, status: 'renamed', oldPath: 'old-coast.ts' }];
const workspaceScope = { serverId: 'home-a', machineId: 'machine-a', rootPath: '/coast' };
const fetchDiff: NonNullable<Parameters<typeof useChangedFilesReviewDiffLoading>[0]['fetchUnifiedDiffForPath']> =
    input => fetchWorkspaceUnifiedDiffForPath({ ...input, scope: workspaceScope });
const capturedFile = ScmComparisonFileSchema.parse({ path: 'coast.ts', previousPath: 'old-coast.ts', changeKind: 'renamed',
    beforeBlobId: 'fixed-before-blob', binary: false, generated: false, lockfile: false,
    evidence: { state: 'available', unifiedDiff: diff }, occurrences: [] });
const capturedDiffs = new Map([['coast.ts', diff]]);

describe('review Find context loading', () => {
    it.each([false, true])('preserves a loaded Find corpus while revalidating a snapshot (changed patch=%s)', async (changedPatch) => {
        scm.diff.mockResolvedValue({ success: true, diff });
        const bytes = Buffer.from(baseText);
        scm.read.mockResolvedValue({ success: true, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') });
        const reveal = vi.fn();
        let signature = `refresh-${changedPatch}-first`;
        const hook = await renderHook(() => {
            const loading = useChangedFilesReviewDiffLoading({ sessionId: '', isRepo: true, reviewFiles: files,
                diffArea: 'pending', selectedPath: 'coast.ts', tooLarge: false, normalizeError: String, fallbackError: 'unavailable',
                fetchUnifiedDiffForPath: fetchDiff, workspaceScope, findContext: true, snapshotSignature: signature });
            const [find] = React.useState(createChangedFilesReviewFind);
            React.useEffect(() => find.connect({ paths: ['coast.ts'], diffStateSource: loading.diffStateSource, reveal }), [find, loading.diffStateSource]);
            return { ...loading, find };
        });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().diffStateSource.getDiffState('coast.ts').context?.status).toBe('loaded');
        });
        await act(() => { hook.getCurrent().find.open(); hook.getCurrent().find.setQuery('hidden cedar'); });
        const corpus = hook.getCurrent().find.getFileSnapshot('coast.ts');
        const duringRefresh: FindStatus[] = [];
        const unsubscribe = hook.getCurrent().find.subscribe(() => duringRefresh.push(hook.getCurrent().find.status));
        reveal.mockClear(); scm.read.mockClear();
        const rereading = createDeferred<unknown>();
        scm.read.mockReturnValue(rereading.promise);
        if (changedPatch) scm.diff.mockResolvedValue({ success: true, diff: diff.replace('+changed 2', '+updated 2') });
        signature = `refresh-${changedPatch}-second`;
        await hook.rerender();
        await flushHookEffects();
        expect(hook.getCurrent().find.getFileSnapshot('coast.ts')).toBe(corpus);
        expect(duringRefresh.every(status => 'total' in status && status.total === 1)).toBe(true);
        expect(reveal).not.toHaveBeenCalled();
        await act(async () => rereading.resolve({ success: true, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') }));
        await flushHookEffects();
        if (!changedPatch) expect(hook.getCurrent().find.getFileSnapshot('coast.ts')).toBe(corpus);
        expect(hook.getCurrent().diffStateSource.getDiffState('coast.ts').diff).toBe(changedPatch ? diff.replace('+changed 2', '+updated 2') : diff);
        expect(hook.getCurrent().find.status).toMatchObject({ current: 1, total: 1 });
        expect(reveal).not.toHaveBeenCalled();
        const changed = Buffer.from(baseText.replace('coast 16', 'hidden cedar again'));
        scm.read.mockResolvedValue({ success: true, contentBase64: changed.toString('base64'), sizeBytes: changed.length,
            sha256: createHash('sha256').update(changed).digest('hex') });
        signature = `refresh-${changedPatch}-third`;
        await hook.rerender();
        await flushHookEffects();
        expect(hook.getCurrent().find.getSnapshot()).toMatchObject({ open: true, query: 'hidden cedar',
            status: { kind: 'results', current: 1, total: 2, coverage: 'complete' } });
        expect(reveal).not.toHaveBeenCalled();
        unsubscribe();
    });
    it.each(['workspace', 'workspace-rename', 'workspace-pending-rename', 'captured'] as const)('reads the %s revision on Find demand through the real loader and matcher', async (kind) => {
        scm.diff.mockResolvedValue({ success: true, diff });
        const reading = createDeferred<unknown>();
        scm.read.mockReturnValue(reading.promise);
        let open = false;
        const hook = await renderHook(() => {
            const loading = useChangedFilesReviewDiffLoading({ sessionId: '', isRepo: true,
                reviewFiles: kind === 'workspace-rename' || kind === 'workspace-pending-rename' ? renamedFiles : files,
                diffArea: kind === 'workspace-rename' ? 'both' : 'pending', selectedPath: 'coast.ts', tooLarge: false, normalizeError: String, fallbackError: 'unavailable',
                fetchUnifiedDiffForPath: fetchDiff,
                workspaceScope, findContext: open,
                ...(kind === 'captured' ? { comparisonFiles: [capturedFile], providerDiffByPath: capturedDiffs } : {}) });
            const [find] = React.useState(createChangedFilesReviewFind);
            React.useEffect(() => find.connect({ paths: ['coast.ts'], diffStateSource: loading.diffStateSource, reveal() {} }), [find, loading.diffStateSource]);
            return { ...loading, find };
        });
        await flushHookEffects();
        expect(scm.read).not.toHaveBeenCalled();
        open = true;
        await hook.rerender();
        await act(() => { hook.getCurrent().find.open(); hook.getCurrent().find.setQuery('hidden cedar'); });
        await flushHookEffects();
        expect(hook.getCurrent().find.status).toMatchObject({ kind: 'searching' });
        const bytes = Buffer.from(baseText);
        await act(async () => reading.resolve({ success: true, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().find.status).toMatchObject({ kind: 'results', current: 1, total: 1, coverage: 'complete' });
        });
        expect(scm.read).toHaveBeenCalledWith('machine-a', expect.objectContaining({ cwd: '/coast',
            path: kind === 'workspace-rename' || kind === 'captured' ? 'old-coast.ts' : 'coast.ts',
            selector: kind === 'captured' ? { blobId: 'fixed-before-blob' } : { side: 'before', area: kind === 'workspace-rename' ? 'both' : 'pending' } }),
            expect.objectContaining({ serverId: 'home-a' }));
        if (kind === 'workspace-rename' || kind === 'workspace-pending-rename') expect(scm.diff).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            renamed: { path: 'coast.ts', previousPath: 'old-coast.ts' }, area: kind === 'workspace-rename' ? 'both' : 'pending',
        }), expect.objectContaining({ serverId: 'home-a' }));
        open = false;
        await hook.rerender();
        expect(hook.getCurrent().diffStateSource.getDiffState('coast.ts')).not.toHaveProperty('context');
    });

    it('retires an unfinished revision read when Find closes', async () => {
        scm.diff.mockResolvedValue({ success: true, diff });
        const reading = createDeferred<unknown>();
        scm.read.mockReturnValue(reading.promise);
        let open = true;
        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({ sessionId: '', isRepo: true, reviewFiles: files,
            diffArea: 'pending', selectedPath: 'coast.ts', tooLarge: false, normalizeError: String, fallbackError: 'unavailable',
            fetchUnifiedDiffForPath: fetchDiff, workspaceScope, findContext: open }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(scm.read).toHaveBeenCalled();
        });
        const signal = scm.read.mock.lastCall?.[2].signal as AbortSignal;
        open = false;
        await hook.rerender();
        expect(signal.aborted).toBe(true);
        await act(async () => { reading.resolve({ success: false, errorCode: 'blob_unavailable' }); });
        await flushHookEffects();
        expect(hook.getCurrent().diffStateSource.getDiffState('coast.ts')).not.toHaveProperty('context');
    });
});
