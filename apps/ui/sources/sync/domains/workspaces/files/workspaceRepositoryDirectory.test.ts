import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineFilesystemListDirectoryMock = vi.fn();

vi.mock('@/sync/ops/machineFileBrowser', () => ({
    machineFilesystemListDirectory: (...args: unknown[]) => machineFilesystemListDirectoryMock(...args),
}));

describe('workspaceRepositoryDirectory', () => {
    beforeEach(() => {
        vi.resetModules();
        machineFilesystemListDirectoryMock.mockReset();
    });

    it('caches directory entries by workspaceCacheKey + directoryPath', async () => {
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
            workspaceCacheKey: 'ws-a',
            machineId: 'm1',
            rootPath: '/repo',
            directoryPath: '',
        });
        expect(res1.ok).toBe(true);

        const resCached = await mod.warmWorkspaceRepositoryDirectoryCache({
            workspaceCacheKey: 'ws-a',
            machineId: 'm1',
            rootPath: '/repo',
            directoryPath: '',
        });
        expect(resCached.ok).toBe(true);

        // Different workspace cache key should not reuse ws-a cache.
        const res2 = await mod.warmWorkspaceRepositoryDirectoryCache({
            workspaceCacheKey: 'ws-b',
            machineId: 'm1',
            rootPath: '/repo',
            directoryPath: '',
        });
        expect(res2.ok).toBe(true);

        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(2);
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
            workspaceCacheKey: 'ws-a',
            machineId: 'm1',
            rootPath: '/repo',
            directoryPath: '',
        });
        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(1);

        mod.clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: 'ws-a' });

        await mod.warmWorkspaceRepositoryDirectoryCache({
            workspaceCacheKey: 'ws-a',
            machineId: 'm1',
            rootPath: '/repo',
            directoryPath: '',
        });
        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(2);
    });
});
