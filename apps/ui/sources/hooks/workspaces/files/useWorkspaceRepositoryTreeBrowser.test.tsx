import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { DaemonFilesystemListDirectoryRequestSchema } from '@happier-dev/protocol/machines/fileBrowser';
import { useWorkspaceRepositoryTreeBrowser } from './useWorkspaceRepositoryTreeBrowser';
import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { storage } from '@/sync/domains/state/storageStore';

type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const directoryRpc = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(directoryRpc);
});
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => ({ serverId: 'reload-home', serverUrl: 'https://example.com', generation: 1 }),
}));

const originalStorage = storage.getState();
afterEach(async () => { await standardCleanup(); storage.setState(originalStorage); });

describe('useWorkspaceRepositoryTreeBrowser', () => {
    it.each([500, 501])('preserves the listing boundary and incompleteness for %i files through fresh, warm and offline trees', async (count) => {
        const scope = { serverId: 'reload-home', machineId: 'listing-machine', rootPath: `/listing-${count}` };
        const workspaceCacheKey = buildWorkspaceCacheKey(scope);
        clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey });
        const files = Array.from({ length: count }, (_, index) => ({
            name: `f${String(index + 1).padStart(4, '0')}.txt`, type: 'file', size: 1,
            path: `${scope.rootPath}/f${String(index + 1).padStart(4, '0')}.txt`,
        }));
        directoryRpc.mockImplementation(async request => {
            const { path } = DaemonFilesystemListDirectoryRequestSchema.parse(request.payload);
            return { ok: true, path, entries: files.slice(0, 500), truncated: count > 500 };
        });
        const expectListing = (nodes: ReturnType<typeof useWorkspaceRepositoryTreeBrowser>['nodes']) => {
            expect(nodes.filter(node => node.type === 'file')).toHaveLength(500);
            expect(nodes.filter(node => node.type === 'file').at(-1)?.name).toBe('f0500.txt');
            expect(nodes.filter(node => node.type === 'info')).toEqual(count > 500 ? [expect.objectContaining({
                infoKind: 'truncated', entryCount: 500, parentDirectoryPath: '',
            })] : []);
        };
        const hook = await renderHook(() => useWorkspaceRepositoryTreeBrowser({ scope, enabled: true }));
        await vi.waitFor(() => expectListing(hook.getCurrent().nodes));
        await hook.unmount();
        const { warmWorkspaceRepositoryDirectoryCache } = await import('@/sync/domains/workspaces/files/workspaceRepositoryDirectory');
        expect(await warmWorkspaceRepositoryDirectoryCache({ scope, directoryPath: '' }))
            .toMatchObject({ ok: true, truncated: count > 500 });
        const offline = await renderHook(() => useWorkspaceRepositoryTreeBrowser({ scope, enabled: false }));
        expectListing(offline.getCurrent().nodes);
        await offline.unmount();
        clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey });
    });

    it('reconciles real Write settlements through the transcript reducer and queues edits without guessing shell paths', async () => {
        const scope = { serverId: 'reload-home', machineId: 'write-machine', rootPath: '/write-repo' };
        const sessionId = 'tree-write-stream';
        storage.setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId: scope.serverId,
            active: true, activeAt: Date.now(), thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress',
            metadata: { path: scope.rootPath, machineId: scope.machineId, host: 'test' } }) },
            machines: { [scope.machineId]: createMachineFixture({ id: scope.machineId, active: true }) },
            sessionMessages: { [sessionId]: { messageIdsOldestFirst: [], messagesById: {}, messagesMap: {},
                reducerState: createReducer(), messagesVersion: 1, isLoaded: true,
                latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null } },
            sessionListRowsByServerId: {}, sessionListIndexByServerId: {}, ordinarySessionListMembershipByServerId: {},
            getProjectForSession: () => null,
        });
        let children: string[] = [];
        const listed: string[] = [];
        directoryRpc.mockImplementation(async request => {
            const { path } = DaemonFilesystemListDirectoryRequestSchema.parse(request.payload);
            listed.push(path);
            return { ok: true, path, truncated: false, entries: path === scope.rootPath
                ? [{ name: 'src', path: `${path}/src`, type: 'directory' }]
                : children.map(name => ({ name, path: `${path}/${name}`, type: 'file' })) };
        });
        const expandedPaths = ['src'];
        const onExpandedPathsChange = () => {};
        const hook = await renderHook(({ paused }: { paused: boolean }) => useWorkspaceRepositoryTreeBrowser({
            scope, enabled: true, expandedPaths, onExpandedPathsChange, reconciliationPaused: paused,
        }), { initialProps: { paused: false } });
        await vi.waitFor(() => {
            expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['src']);
            expect(hook.getCurrent().nodes[0]?.isLoadingChildren).toBe(false);
        });
        const applyCall = (id: string, name: string, input: unknown) => storage.getState().applyMessages(sessionId, [{
            id: `call-${id}`, localId: null, createdAt: Date.now(), role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id, name, input, description: null, uuid: `uuid-${id}`, parentUUID: null }],
        }]);
        const applyResult = (id: string, error = false) => storage.getState().applyMessages(sessionId, [{
            id: `result-${id}`, localId: null, createdAt: Date.now() + 1, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-result', tool_use_id: id, content: 'settled', is_error: error,
                uuid: `result-uuid-${id}`, parentUUID: null }],
        }]);
        await act(async () => { applyCall('write', 'Write', { file_path: `${scope.rootPath}/src/created.ts`, content: 'hello' }); });
        expect([...hook.getCurrent().liveFileWrites.keys()]).toEqual(['src/created.ts']);
        expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['src']);
        listed.length = 0;
        children = ['created.ts'];
        await act(async () => { applyResult('write'); });
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['src', 'src/created.ts']));
        expect(listed).toEqual([`${scope.rootPath}/src`]);
        expect(hook.getCurrent().liveFileWrites.size).toBe(0);
        await hook.rerender({ paused: true });
        children = ['created.ts', 'batched.ts'];
        await act(async () => { applyCall('batched', 'Write', { file_path: 'src/batched.ts', content: 'partial' }); applyResult('batched', true); });
        expect(hook.getCurrent().nodes.map(node => node.path)).not.toContain('src/batched.ts');
        await hook.rerender({ paused: false });
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toContain('src/batched.ts'));
        listed.length = 0;
        children = ['created.ts', 'batched.ts', 'shell.ts'];
        await act(async () => { applyCall('shell', 'Bash', { command: 'touch src/shell.ts' }); applyResult('shell'); });
        expect(listed).toEqual([]);
        expect(hook.getCurrent().nodes.map(node => node.path)).not.toContain('src/shell.ts');
    });

    it('reloads the mounted real tree after its qualified workspace directory cache is cleared', async () => {
        const scope = { serverId: 'reload-home', machineId: 'm1', rootPath: '/reload-repo' };
        let name = 'before.ts';
        directoryRpc.mockImplementation(async request => {
            const input = DaemonFilesystemListDirectoryRequestSchema.parse(request.payload);
            return { ok: true, path: input.path, truncated: false, entries: [
                { name, path: `${input.path}/${name}`, type: 'file' },
            ] };
        });
        const hook = await renderHook(() => useWorkspaceRepositoryTreeBrowser({ scope, enabled: true }));
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['before.ts']));
        expect(directoryRpc).toHaveBeenCalledWith(expect.objectContaining({ serverId: scope.serverId,
            machineId: scope.machineId, payload: expect.objectContaining({ path: scope.rootPath }) }));
        name = 'after.ts';
        await act(async () => clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: buildWorkspaceCacheKey(scope) }));
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['after.ts']));
        await hook.unmount();
    });
});
