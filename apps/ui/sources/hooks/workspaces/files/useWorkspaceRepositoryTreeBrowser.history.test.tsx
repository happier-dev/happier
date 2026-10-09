import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { DaemonFilesystemListDirectoryRequestSchema, type DaemonFilesystemListDirectoryRequest, type DaemonFilesystemListDirectoryResponse } from '@happier-dev/protocol/machines/fileBrowser';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { useWorkspaceRepositoryTreeBrowser } from './useWorkspaceRepositoryTreeBrowser';
import { useWorkspaceEntryHistory } from './useWorkspaceEntryHistory';

type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const { historyRpc, directoryRpc } = vi.hoisted(() => ({
    historyRpc: vi.fn<(request: RpcRequest) => Promise<unknown>>(),
    directoryRpc: vi.fn<(machineId: string, request: DaemonFilesystemListDirectoryRequest) => Promise<DaemonFilesystemListDirectoryResponse>>(),
}));
// Only the network boundary is replaced. Both typed RPC facades, directory caches and retirement stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async request => request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY
        ? directoryRpc(request.machineId, DaemonFilesystemListDirectoryRequestSchema.parse(request.payload)) : historyRpc(request));
});

const scope = { serverId: 'history-home', machineId: 'history-machine', rootPath: '/history-repo' };
const oldHead = 'a'.repeat(40);
const newHead = 'b'.repeat(40);

describe('workspace browser demanded history', () => {
    beforeEach(() => { historyRpc.mockReset(); directoryRpc.mockReset(); });
    it('maps nested workspace demand into the captured repository and returns only workspace entry identities', async () => {
        const nestedScope = { ...scope, rootPath: '/repository/sub' };
        historyRpc.mockImplementation(async request => {
            expect(request.payload).toMatchObject({ cwd: nestedScope.rootPath, folder: 'sub', paths: ['sub', 'sub/one'], headOid: newHead });
            return { success: true, headOid: newHead, entries: [
                { path: 'one', kind: 'commit', commit: { oid: oldHead, subject: 'wrong root file', authorName: 'A', committedAt: 1000 } },
                { path: 'sub', kind: 'none' },
                { path: 'sub/one', kind: 'commit', commit: { oid: newHead, subject: 'nested file', authorName: 'B', committedAt: 2000 } },
            ] };
        });
        const hook = await renderHook(() => useWorkspaceEntryHistory({ scope: nestedScope, repoRootPath: '/repository',
            folder: '', paths: ['', 'one'], headOid: newHead, enabled: true }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect([...hook.getCurrent().entries.keys()]).toEqual(['', 'one']);
        expect(hook.getCurrent().entries.get('one')).toMatchObject({ path: 'one', kind: 'commit', commit: { subject: 'nested file' } });
        expect(hook.getCurrent().entries.get('')).toEqual({ path: '', kind: 'none' });
    });
    it.each([null, '/repository-other'])('does not query a missing or incompatible repository root %s', async repoRootPath => {
        const hook = await renderHook(() => useWorkspaceEntryHistory({ scope: { ...scope, rootPath: '/repository/sub' },
            repoRootPath, folder: '', paths: ['one'], headOid: newHead, enabled: true }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
        expect(hook.getCurrent().entries.size).toBe(0);
        expect(historyRpc).not.toHaveBeenCalled();
    });
    it('preserves nested Windows spelling after qualified containment and labels retained facts when the root disappears', async () => {
        const windowsScope = { ...scope, rootPath: 'c:\\REPO\\Sub Dir' };
        historyRpc.mockImplementation(async request => {
            expect(request.payload).toMatchObject({ cwd: windowsScope.rootPath, folder: 'Sub Dir/Nested', paths: ['Sub Dir/Nested/Name '] });
            return { success: true, headOid: newHead, entries: [{ path: 'Sub Dir/Nested/Name ', kind: 'none' }] };
        });
        const hook = await renderHook((repoRootPath: string | null) => useWorkspaceEntryHistory({ scope: windowsScope,
            repoRootPath, folder: 'Nested', paths: ['Nested/Name '], headOid: newHead, enabled: true }),
        { initialProps: 'C:/repo' });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().entries.get('Nested/Name ')).toEqual({ path: 'Nested/Name ', kind: 'none' });
        historyRpc.mockClear();
        await hook.rerender(null);
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
        expect(hook.getCurrent().stale).toBe(true);
        expect(hook.getCurrent().entries.get('Nested/Name ')?.kind).toBe('none');
        expect(historyRpc).not.toHaveBeenCalled();
    });
    it('rejects a newly committed response to an explicit unborn witness and retains only last-known facts', async () => {
        historyRpc.mockResolvedValueOnce({ success: true, headOid: null,
            entries: [{ path: 'LICENSE', kind: 'none' }] });
        const hook = await renderHook((reloadToken: number) => useWorkspaceEntryHistory({
            scope: { ...scope, rootPath: '/unborn-history-witness' }, folder: '', paths: ['LICENSE'],
            repoRootPath: '/unborn-history-witness', headOid: null, enabled: true, reloadToken,
        }), { initialProps: 0 });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        historyRpc.mockResolvedValue({ success: true, headOid: newHead,
            entries: [{ path: 'LICENSE', kind: 'commit', commit: { oid: newHead, subject: 'new checkout', authorName: 'A', committedAt: 1000 } }] });
        await hook.rerender(1);
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
        expect(hook.getCurrent()).toMatchObject({ headOid: null, stale: true, reason: 'SCM_SOURCE_CHANGED' });
        expect(hook.getCurrent().entries.get('LICENSE')).toEqual({ path: 'LICENSE', kind: 'none' });
    });
    it('preserves literal whitespace names through directory expansion and history demand', async () => {
        const literalScope = { ...scope, rootPath: '/literal-history-browser' };
        const folder = ' leading\nfolder ';
        directoryRpc.mockImplementation(async (_machine, request) => ({
            ok: true, path: request.path, truncated: false,
            entries: request.path === literalScope.rootPath ? [
                { name: folder, path: `${request.path}/${folder}`, type: 'directory' },
                { name: 'name ', path: `${request.path}/name `, type: 'file' },
                { name: ' ', path: `${request.path}/ `, type: 'file' },
            ] : request.path === `${literalScope.rootPath}/${folder}` ? [
                { name: ' child ', path: `${request.path}/ child `, type: 'file' },
            ] : [],
        }));
        historyRpc.mockImplementation(async request => ({
            success: true, headOid: newHead,
            entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'none' })),
        }));
        const hook = await renderHook(() => useWorkspaceRepositoryTreeBrowser({
            scope: literalScope, repoRootPath: literalScope.rootPath, enabled: true, historyEnabled: true, headOid: newHead,
        }));
        await vi.waitFor(() => expect(hook.getCurrent().history.status).toBe('ready'));
        expect(hook.getCurrent().nodes.map(node => [node.name, node.path])).toEqual([
            [folder, folder], [' ', ' '], ['name ', 'name '],
        ]);
        await act(async () => hook.getCurrent().toggleDirectory(folder));
        await vi.waitFor(() => expect(hook.getCurrent().history.entries.has(`${folder}/ child `)).toBe(true));
        expect(directoryRpc.mock.calls.some(([, request]) => request.path === `${literalScope.rootPath}/${folder}`)).toBe(true);
        expect(hook.getCurrent().nodes.find(node => node.path === folder)).toMatchObject({ isExpanded: true });
    });
    it.each([newHead, null])('marks last-known facts stale in the first render after HEAD changes to %s', async nextHead => {
        historyRpc.mockImplementation(async request => {
            if ((request.payload as { headOid?: string }).headOid !== oldHead) return new Promise(() => {});
            return { success: true, headOid: oldHead, entries: [{ path: 'LICENSE', kind: 'none' }] };
        });
        const renders: Array<{ demandedHead: string | null; stale: boolean; known: boolean }> = [];
        const hook = await renderHook((headOid: string | null) => {
            const history = useWorkspaceEntryHistory({ scope, repoRootPath: scope.rootPath, folder: '', paths: ['LICENSE'], headOid, enabled: true });
            renders.push({ demandedHead: headOid, stale: history.stale, known: history.entries.has('LICENSE') });
            return history;
        }, { initialProps: oldHead });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        await hook.rerender(nextHead);
        expect(renders.find(render => render.demandedHead === nextHead)).toEqual({ demandedHead: nextHead, stale: true, known: true });
    });
    it('batches real visible entry facts and discards a retired HEAD response', async () => {
        directoryRpc.mockImplementation(async (_machine, request) => ({
            ok: true, path: request.path, truncated: false, gitIgnoreAvailable: true,
            entries: request.path === scope.rootPath ? [
                { name: 'no-extension', path: '/history-repo/no-extension', type: 'file' },
                { name: 'folder.ts', path: '/history-repo/folder.ts', type: 'directory' },
            ] : [],
        }));
        let resolveOld: ((value: unknown) => void) | undefined;
        const requests: Array<RpcRequest> = [];
        historyRpc.mockImplementation(async (request) => {
            requests.push(request);
            const payload = request.payload as { headOid?: string };
            if (payload.headOid === oldHead) return new Promise(resolve => { resolveOld = resolve; });
            return { success: true, headOid: newHead, entries: [
                { path: 'no-extension', kind: 'commit', commit: { oid: 'c'.repeat(40), subject: 'file change', authorName: 'A', committedAt: 1000 } },
                { path: 'folder.ts', kind: 'commit', commit: { oid: 'd'.repeat(40), subject: 'descendant change', authorName: 'B', committedAt: 2000 } },
            ] };
        });
        const hook = await renderHook((headOid: string) => {
            const input = { scope, repoRootPath: scope.rootPath, enabled: true, historyEnabled: true, headOid };
            return useWorkspaceRepositoryTreeBrowser(input);
        }, { initialProps: oldHead });
        expect(hook.getCurrent().nodes.map(node => [node.path, node.type])).toEqual([['folder.ts', 'directory'], ['no-extension', 'file']]);
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]).toMatchObject({ serverId: scope.serverId, payload: { cwd: scope.rootPath, folder: '', paths: ['folder.ts', 'no-extension'], headOid: oldHead } });
        await hook.rerender(newHead);
        await vi.waitFor(() => expect(hook.getCurrent().history?.status).toBe('ready'));
        expect(hook.getCurrent().history.entries.get('no-extension')).toMatchObject({ kind: 'commit', commit: { oid: 'c'.repeat(40) } });
        expect(hook.getCurrent().history.entries.get('folder.ts')).toMatchObject({ kind: 'commit', commit: { oid: 'd'.repeat(40) } });
        await act(async () => resolveOld?.({ success: true, headOid: oldHead, entries: [{ path: 'no-extension', kind: 'none' }] }));
        expect(hook.getCurrent().history?.entries.get('no-extension')?.kind).toBe('commit');
        expect(requests).toHaveLength(2);
    });

    it('keeps directory rows and labels known history stale when a refresh is unavailable', async () => {
        const scope = { serverId: 'history-home', machineId: 'history-machine', rootPath: '/history-refresh' };
        directoryRpc.mockResolvedValue({ ok: true, path: scope.rootPath, truncated: false, entries: [{ name: 'no-extension', path: '/history-repo/no-extension', type: 'file' }] });
        historyRpc.mockResolvedValueOnce({ success: true, headOid: newHead, entries: [{ path: 'no-extension', kind: 'none' }] });
        const hook = await renderHook((reloadToken: number) => {
            const input = { scope, repoRootPath: scope.rootPath, enabled: true, historyEnabled: true, headOid: newHead, reloadToken };
            return useWorkspaceRepositoryTreeBrowser(input);
        }, { initialProps: 0 });
        await vi.waitFor(() => expect(hook.getCurrent().history?.status).toBe('ready'));
        historyRpc.mockResolvedValue({ success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'history unavailable' });
        await hook.rerender(1);
        await vi.waitFor(() => expect(hook.getCurrent().history?.status).toBe('unavailable'));
        expect(hook.getCurrent().history?.stale).toBe(true);
        expect(hook.getCurrent().history?.entries.get('no-extension')?.kind).toBe('none');
        expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['no-extension']);
    });

    it('never installs facts whose HEAD differs from the demanded witness', async () => {
        const scope = { serverId: 'history-home', machineId: 'history-machine', rootPath: '/history-mismatch' };
        directoryRpc.mockResolvedValue({ ok: true, path: scope.rootPath, truncated: false, entries: [{ name: 'LICENSE', path: `${scope.rootPath}/LICENSE`, type: 'file' }] });
        historyRpc.mockResolvedValue({ success: true, headOid: oldHead, entries: [{ path: 'LICENSE', kind: 'none' }] });
        const input = { scope, repoRootPath: scope.rootPath, enabled: true, historyEnabled: true, headOid: newHead };
        const hook = await renderHook(() => useWorkspaceRepositoryTreeBrowser(input));
        await vi.waitFor(() => expect(hook.getCurrent().history?.status).toBe('unavailable'));
        expect(hook.getCurrent().history?.entries.size).toBe(0);
        expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['LICENSE']);
    });

    it('retires the addressed Home and folder demand without exposing old entries', async () => {
        directoryRpc.mockImplementation(async (_machine, request) => ({
            ok: true, path: request.path, truncated: false,
            entries: [{ name: 'LICENSE', path: `${request.path}/LICENSE`, type: 'file' }],
        }));
        let release: ((value: unknown) => void) | undefined;
        historyRpc.mockImplementation(async (request) => {
            if (request.serverId === 'retired-home') return new Promise(resolve => { release = resolve; });
            return { success: true, headOid: newHead, entries: [{ path: 'nested/LICENSE', kind: 'commit', commit: {
                oid: 'e'.repeat(40), subject: 'current folder', authorName: 'C', committedAt: 3000,
            } }] };
        });
        const renders: Array<{ serverId: string; paths: string[] }> = [];
        const hook = await renderHook(({ serverId, folder }: { serverId: string; folder: string }) => {
            const result = useWorkspaceRepositoryTreeBrowser({
                scope: { serverId, machineId: 'retirement-machine', rootPath: '/retirement' }, rootDirectoryPath: folder,
                repoRootPath: '/retirement', enabled: true, historyEnabled: true, headOid: newHead,
            });
            renders.push({ serverId, paths: result.nodes.map(node => node.path) });
            return result;
        }, { initialProps: { serverId: 'retired-home', folder: '' } });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await hook.rerender({ serverId: 'current-home', folder: 'nested' });
        expect(renders.find(render => render.serverId === 'current-home')?.paths).toEqual([]);
        await vi.waitFor(() => expect(hook.getCurrent().history.status).toBe('ready'));
        await act(async () => release?.({ success: true, headOid: newHead, entries: [{ path: 'LICENSE', kind: 'none' }] }));
        expect(hook.getCurrent().history.entries.has('LICENSE')).toBe(false);
        expect(hook.getCurrent().history.entries.get('nested/LICENSE')).toMatchObject({ kind: 'commit', commit: { subject: 'current folder' } });
        expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['nested/LICENSE']);
    });
});
