import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let listingPaths = ['shared.ts', 'bob.ts'];
installSessionActionRpcBoundary(request => request.method.endsWith(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST)
    ? { ok: true, paths: listingPaths, truncated: false }
    : { success: false, errorCode: 'FEATURE_UNSUPPORTED' });
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { recentWorkspaceFilesState } = await import('@/sync/domains/state/filePaneUiState');
const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
const { recordWorkspaceFileOpen } = await import('@/sync/store/files/recentWorkspaceFiles');
const { workspaceFileSearchCache, searchWorkspaceFiles } = await import('@/sync/domains/workspaces/files/workspaceFileSearch');
const { readQuickOpenRecentFiles, useQuickOpenFileSources } = await import('./useQuickOpenEmptyState');
const originalState = storage.getState();
const serverUrl = 'https://recent-account-state.test';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
const address = () => ({ serverId, machineId: 'recent-machine', rootPath: '/repo' });

function admitMachine(accountId: string) {
    const row = createPlainMachineRowFixture({ id: address().machineId, accountId });
    homes.answer(serverId, `/v1/machines/${row.id}`, { body: { machine: row } });
    homes.answer(serverId, 'POST /v1/machines/read-batch', {
        select: async input => ({ body: await createMachineReadBatchResponseFixture(input, id => id === row.id ? row : null).json() }),
    });
    storage.getState().applyMachines([createMachineFixture({ id: row.id, access: row.access })]);
}

beforeEach(async () => {
    listingPaths = ['shared.ts', 'bob.ts'];
    serverId = await homes.addHome({ name: 'Recent Home', serverUrl, serverIdentityId: 'srv_recent_accounts', accountId: 'alice' });
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: 'srv_recent_accounts', accountId: 'alice', request: homes.request });
    serverId = connection.serverId;
    workspaceFileSearchCache.clearAll();
    await vi.waitFor(() => expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe('alice'));
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose(); connection = undefined;
    await homes.reset();
    workspaceFileSearchCache.clearAll();
    storage.setState(originalState, true);
});

describe('Account-owned Recent files', () => {
    it('validates twenty Recent paths without rereading the admitted listing on each open', async () => {
        const scope = address();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        // Exercise the real list-response boundary, whose existing corpus page is 5,000 paths.
        listingPaths = Array.from({ length: 5_000 }, (_, index) => `src/file-${index}.ts`);
        admitMachine('alice');
        await searchWorkspaceFiles({ scope, query: '', accountLifetime: lifetime });
        const workspaceKey = buildWorkspaceCacheKey(scope);
        for (let index = 0; index < 20; index += 1) recordWorkspaceFileOpen(lifetime.scope, workspaceKey, listingPaths[index]!);
        let fileKindReads = 0;
        for (const file of workspaceFileSearchCache.readFiles(scope, lifetime) ?? []) {
            const kind = file.fileType;
            Object.defineProperty(file, 'fileType', { configurable: true, get: () => { fileKindReads += 1; return kind; } });
        }
        for (let open = 0; open < 3; open += 1) {
            expect(readQuickOpenRecentFiles(scope).map(file => file.fullPath)).toEqual(listingPaths.slice(0, 20).reverse());
        }
        expect(fileKindReads).toBe(0);
        listingPaths = ['fresh.ts'];
        workspaceFileSearchCache.clearCache(scope);
        await searchWorkspaceFiles({ scope, query: '', accountLifetime: lifetime });
        expect(readQuickOpenRecentFiles(scope)).toEqual([]);
        recordWorkspaceFileOpen(lifetime.scope, workspaceKey, 'fresh.ts');
        expect(readQuickOpenRecentFiles(scope).map(file => file.fullPath)).toEqual(['fresh.ts']);
    });

    it('keeps both readers isolated through a real Account replacement and listing hydration', async () => {
        const scope = address();
        const workspaceKey = buildWorkspaceCacheKey(scope);
        const aliceScope = captureActiveServerAccountScopeLifetime()!.scope;
        recordWorkspaceFileOpen(aliceScope, workspaceKey, 'alice-private.ts');
        recordWorkspaceFileOpen(aliceScope, workspaceKey, 'shared.ts');
        const hook = await renderHook(() => useQuickOpenFileSources({ scope }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().accountId).toBe('alice'));
            expect(hook.getCurrent().recent.map(file => file.fullPath)).toEqual(['shared.ts', 'alice-private.ts']);
            expect(readQuickOpenRecentFiles(scope).map(file => file.fullPath)).toEqual(['shared.ts', 'alice-private.ts']);
            const aliceLifetime = captureActiveServerAccountScopeLifetime()!;
            await act(async () => homes.switchAccount(serverId, 'bob'));
            await vi.waitFor(() => expect(hook.getCurrent().accountId).toBe('bob'));
            await vi.waitFor(() => expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe('bob'));
            expect(aliceLifetime.isCurrent()).toBe(false);
            const bobLifetime = captureActiveServerAccountScopeLifetime()!;
            expect(bobLifetime.scope.accountId).toBe('bob');
            expect(workspaceFileSearchCache.readFiles(scope, bobLifetime)).toBeNull();
            expect(hook.getCurrent().recent).toEqual([]);
            expect(readQuickOpenRecentFiles(scope)).toEqual([]);
            admitMachine('bob');
            await act(async () => { await searchWorkspaceFiles({ scope, query: '', accountLifetime: bobLifetime }); });
            expect(workspaceFileSearchCache.readFiles(scope, bobLifetime)?.map(file => file.fullPath)).toContain('bob.ts');
            await hook.rerender();
            expect(hook.getCurrent().recent).toEqual([]);
            expect(readQuickOpenRecentFiles(scope)).toEqual([]);
            await act(async () => recordWorkspaceFileOpen(bobLifetime.scope, workspaceKey, 'bob.ts'));
            expect(hook.getCurrent().recent.map(file => file.fullPath)).toEqual(['bob.ts']);
            expect(readQuickOpenRecentFiles(scope).map(file => file.fullPath)).toEqual(['bob.ts']);
            await act(async () => homes.switchAccount(serverId, 'alice'));
            await vi.waitFor(() => expect(hook.getCurrent().accountId).toBe('alice'));
            expect(hook.getCurrent().recent.map(file => file.fullPath)).toEqual(['shared.ts', 'alice-private.ts']);
            expect(readQuickOpenRecentFiles(scope).map(file => file.fullPath)).toEqual(['shared.ts', 'alice-private.ts']);
        } finally { await hook.unmount(); }
    });

    it('does not adopt an unqualified record into the Account that happens to read it first', async () => {
        const scope = address();
        const key = buildWorkspaceCacheKey(scope);
        recentWorkspaceFilesState.set(key, ['unattributed-secret.ts']);
        const hook = await renderHook(() => useQuickOpenFileSources({ scope }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().accountId).toBe('alice'));
            expect(hook.getCurrent().recent).toEqual([]);
            expect(readQuickOpenRecentFiles(scope)).toEqual([]);
            expect(recentWorkspaceFilesState.read(key)).toEqual(['unattributed-secret.ts']);
        } finally { await hook.unmount(); }
    });

    it('keeps a refused optional history write recoverable and a serialization error loud', () => {
        const key = buildWorkspaceCacheKey(address());
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        const write = vi.spyOn(getPersistenceStorage(), 'set').mockImplementation(() => { throw new Error('device refused'); });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(() => recordWorkspaceFileOpen(scope, key, 'readable.ts')).not.toThrow();
            expect(warn).toHaveBeenCalled();
        } finally { write.mockRestore(); warn.mockRestore(); }
        expect(() => recordWorkspaceFileOpen(scope, key, 'readable.ts')).not.toThrow();
        const cyclicPath = { self: {} };
        cyclicPath.self = cyclicPath;
        // @ts-expect-error Deliberate caller programmer error: real serialization must remain loud.
        expect(() => recordWorkspaceFileOpen(scope, key, cyclicPath)).toThrow(TypeError);
    });
});
