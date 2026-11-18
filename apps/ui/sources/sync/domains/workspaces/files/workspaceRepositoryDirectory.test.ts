import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceListDirectoryMock = vi.fn();

vi.mock('@/sync/ops/workspaceFileSystem/directoryBrowsing', () => ({
    workspaceListDirectory: (...args: unknown[]) => workspaceListDirectoryMock(...args),
}));

/**
 * Two workspaces reached through two different servers. Same machine id, same root path — a
 * machine id is only unique within its server — so these must not share a cache entry, and
 * they must each be listed through their own server.
 */
const SCOPE_A = { serverId: 'server-a', machineId: 'm1', rootPath: '/repo' } as const;
const SCOPE_B = { serverId: 'server-b', machineId: 'm1', rootPath: '/repo' } as const;

describe('workspaceRepositoryDirectory', () => {
    beforeEach(() => {
        vi.resetModules();
        workspaceListDirectoryMock.mockReset();
    });

    it('caches directory entries by workspace scope + directoryPath, and lists through that scope\'s server', async () => {
        workspaceListDirectoryMock.mockResolvedValue({
            success: true,
            path: '/repo',
            truncated: false,
            entries: [
                { name: 'src', path: '/repo/src', type: 'directory' },
                { name: 'README.md', path: '/repo/README.md', type: 'file', size: 10, modified: 1 },
            ],
        });

        const mod = await import('./workspaceRepositoryDirectory');

        const res1 = await mod.listWorkspaceRepositoryDirectoryEntries({
            scope: SCOPE_A,
            directoryPath: '',
        });
        expect(res1.ok).toBe(true);

        const resCached = await mod.warmWorkspaceRepositoryDirectoryCache({
            scope: SCOPE_A,
            directoryPath: '',
        });
        expect(resCached.ok).toBe(true);

        // A different server addresses a different workspace and must not reuse A's cache.
        const res2 = await mod.warmWorkspaceRepositoryDirectoryCache({
            scope: SCOPE_B,
            directoryPath: '',
        });
        expect(res2.ok).toBe(true);

        expect(workspaceListDirectoryMock).toHaveBeenCalledTimes(2);
        // Each read went out on the server its own scope names — the entry cannot be filed
        // under one server while being read through another.
        const serverIds = workspaceListDirectoryMock.mock.calls
            .map(([scope]) => (scope as Readonly<{ serverId: string }>).serverId);
        expect(serverIds).toEqual(['server-a', 'server-b']);
    });

    it('clears cached entries for a workspace', async () => {
        workspaceListDirectoryMock.mockResolvedValue({
            success: true,
            path: '/repo',
            truncated: false,
            entries: [
                { name: 'a', path: '/repo/a', type: 'file' },
            ],
        });

        const mod = await import('./workspaceRepositoryDirectory');

        await mod.warmWorkspaceRepositoryDirectoryCache({
            scope: SCOPE_A,
            directoryPath: '',
        });
        expect(workspaceListDirectoryMock).toHaveBeenCalledTimes(1);

        // The key-addressed clear must name the same entry the scope-addressed warm filled;
        // both go through `tryBuildWorkspaceCacheKey`, and this is where that agreement holds.
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        mod.clearCachedWorkspaceRepositoryDirectoryEntries({
            workspaceCacheKey: buildWorkspaceCacheKey(SCOPE_A),
        });

        await mod.warmWorkspaceRepositoryDirectoryCache({
            scope: SCOPE_A,
            directoryPath: '',
        });
        expect(workspaceListDirectoryMock).toHaveBeenCalledTimes(2);
    });

    it('prunes cached descendants when a refreshed parent no longer contains their directory', async () => {
        const mod = await import('./workspaceRepositoryDirectory');
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const workspaceCacheKey = buildWorkspaceCacheKey(SCOPE_A);
        mod.setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '', entries: [{ name: 'src', type: 'directory' }] });
        mod.setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src', entries: [{ name: 'old.ts', type: 'file' }] });
        mod.setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src/deep', entries: [{ name: 'stale.ts', type: 'file' }] });
        mod.setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src-other', entries: [{ name: 'keep.ts', type: 'file' }] });
        workspaceListDirectoryMock.mockResolvedValue({ success: true, path: '/repo', entries: [] });
        await mod.listWorkspaceRepositoryDirectoryEntries({ scope: SCOPE_A, directoryPath: '' });
        expect(mod.getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src' })).toBeNull();
        expect(mod.getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src/deep' })).toBeNull();
        expect(mod.getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src-other' })).toEqual([{ name: 'keep.ts', type: 'file' }]);
    });
});


describe('workspace directory Git ignore metadata', () => {
    it('preserves classification through the canonical workspace cache', async () => {
        workspaceListDirectoryMock.mockReset().mockResolvedValue({ success: true, path: '/repo', truncated: false, gitIgnoreAvailable: true,
            entries: [{ name: 'node_modules', path: '/repo/node_modules', type: 'directory', gitIgnored: true }, { name: '.env.example', path: '/repo/.env.example', type: 'file', gitIgnored: false }],
        });
        const mod = await import('./workspaceRepositoryDirectory');
        const input = { scope: SCOPE_A, directoryPath: 'classified' };
        const result = await mod.listWorkspaceRepositoryDirectoryEntries(input);
        expect(result).toMatchObject({ ok: true, gitIgnoreAvailable: true, entries: [{ gitIgnored: true }, { gitIgnored: false }] });
        expect(await mod.warmWorkspaceRepositoryDirectoryCache(input)).toEqual(result);
    });
    it('keeps old daemon entries unclassified and visible', async () => {
        workspaceListDirectoryMock.mockReset().mockResolvedValue({ success: true, path: '/repo', truncated: false,
            entries: [{ name: 'node_modules', path: '/repo/node_modules', type: 'directory' }],
        });
        const mod = await import('./workspaceRepositoryDirectory');
        expect(await mod.listWorkspaceRepositoryDirectoryEntries({ scope: SCOPE_A, directoryPath: 'legacy' })).toMatchObject({ ok: true, gitIgnoreAvailable: false, entries: [{ name: 'node_modules' }] });
    });
});

describe('workspace directory cache across an Account change on one Home', () => {
    const scope = { serverId: 'account-change-tree', machineId: 'shared-machine', rootPath: '/repo' } as const;
    const location = { serverUrl: 'https://account-change-tree', serverId: scope.serverId };
    const response = (name: string) => ({ success: true, path: '/repo', truncated: false, entries: [{ name, path: `/repo/${name}`, type: 'file' }] });

    async function signIn(accountId: string) {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        expect(await TokenStorage.setCredentialsForServerUrl(location.serverUrl, { serverId: location.serverId },
            { token: createAccountTokenForTests(accountId) })).toBe(true);
    }

    it('withdraws the previous Account tree, wakes mounted trees, and retains no read still in flight', async () => {
        const { tryBuildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const { getCachedWorkspaceRepositoryDirectoryEntries, listWorkspaceRepositoryDirectoryEntries, warmWorkspaceRepositoryDirectoryCache } = await import('./workspaceRepositoryDirectory');
        const { subscribeWorkspaceRepositoryDirectoryRevision } = await import('./workspaceRepositoryDirectoryRevision');
        const workspaceCacheKey = tryBuildWorkspaceCacheKey(scope)!;
        await signIn('tree-account-a');
        workspaceListDirectoryMock.mockReset();
        workspaceListDirectoryMock.mockResolvedValueOnce(response('a-private.txt'));
        await listWorkspaceRepositoryDirectoryEntries({ scope, directoryPath: '' });
        expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' })?.[0]?.name).toBe('a-private.txt');

        const woken = vi.fn();
        const stop = subscribeWorkspaceRepositoryDirectoryRevision(workspaceCacheKey, woken);
        let settleHeld = (_value: unknown) => {};
        workspaceListDirectoryMock.mockImplementationOnce(() => new Promise(resolve => { settleHeld = resolve; }));
        const held = warmWorkspaceRepositoryDirectoryCache({ scope, directoryPath: 'src' });
        await vi.waitFor(() => expect(workspaceListDirectoryMock).toHaveBeenCalledTimes(2));

        await signIn('tree-account-b');
        expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' })).toBeNull();
        expect(woken).toHaveBeenCalled();

        settleHeld(response('a-private-held.txt'));
        await held;
        expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src' })).toBeNull();
        stop();
    });
});
