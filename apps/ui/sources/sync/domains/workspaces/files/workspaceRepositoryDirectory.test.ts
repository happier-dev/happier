import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineFilesystemListDirectoryMock = vi.fn();

vi.mock('@/sync/ops/machineFileBrowser', () => ({
    machineFilesystemListDirectory: (...args: unknown[]) => machineFilesystemListDirectoryMock(...args),
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
        machineFilesystemListDirectoryMock.mockReset();
    });

    it('caches directory entries by workspace scope + directoryPath, and lists through that scope\'s server', async () => {
        machineFilesystemListDirectoryMock.mockResolvedValue({
            ok: true,
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

        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(2);
        // Each read went out on the server its own scope names — the entry cannot be filed
        // under one server while being read through another.
        const serverIds = machineFilesystemListDirectoryMock.mock.calls
            .map((call) => (call[2] as Readonly<{ serverId?: string | null }> | undefined)?.serverId);
        expect(serverIds).toEqual(['server-a', 'server-b']);
    });

    it('clears cached entries for a workspace', async () => {
        machineFilesystemListDirectoryMock.mockResolvedValue({
            ok: true,
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
        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(1);

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
        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(2);
    });
});
