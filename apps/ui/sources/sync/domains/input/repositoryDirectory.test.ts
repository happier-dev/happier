import { describe, expect, it, vi } from 'vitest';

import {
    clearCachedRepositoryDirectoryEntries,
    getCachedRepositoryDirectoryEntries,
    listRepositoryDirectoryEntries,
    setCachedRepositoryDirectoryEntries,
    sortRepositoryDirectoryEntries,
    warmRepositoryDirectoryCache,
} from './repositoryDirectory';

const machineFilesystemListDirectoryMock = vi.fn();
const readMachineTargetForSessionMock = vi.fn();
const resolvePreferredServerIdForSessionIdMock = vi.fn();
const sessionListDirectoryMock = vi.fn();

vi.mock('@/sync/ops', () => ({
    sessionListDirectory: (...args: unknown[]) => sessionListDirectoryMock(...args),
}));

vi.mock('@/sync/ops/machineFileBrowser', () => ({
    machineFilesystemListDirectory: (...args: unknown[]) => machineFilesystemListDirectoryMock(...args),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (...args: unknown[]) => readMachineTargetForSessionMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (...args: unknown[]) => resolvePreferredServerIdForSessionIdMock(...args),
}));

describe('sortRepositoryDirectoryEntries', () => {
    it('sorts directories first by name, then files by name (case-insensitive)', () => {
        const sorted = sortRepositoryDirectoryEntries([
            { name: 'b.txt', type: 'file' as const },
            { name: 'A', type: 'directory' as const },
            { name: 'a.txt', type: 'file' as const },
            { name: 'b', type: 'directory' as const },
            { name: 'Z', type: 'directory' as const },
        ]);

        expect(sorted.map((e) => `${e.type}:${e.name}`)).toEqual([
            'directory:A',
            'directory:b',
            'directory:Z',
            'file:a.txt',
            'file:b.txt',
        ]);
    });
});

describe('listRepositoryDirectoryEntries', () => {
    it('preserves raw directory entry names for identity (no Unicode normalization)', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'm1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server');
        sessionListDirectoryMock.mockResolvedValue({
            success: true,
            entries: [
                { name: 'Å.txt', type: 'file', size: 12, modified: 1700000000000 },
                { name: 'a.txt', type: 'file' },
            ],
        });
        machineFilesystemListDirectoryMock.mockResolvedValue({
            ok: true,
            path: '/repo',
            truncated: false,
            entries: [
                { name: 'Å.txt', path: '/repo/Å.txt', type: 'file', size: 12, modified: 1700000000000 },
                { name: 'a.txt', path: '/repo/a.txt', type: 'file' },
            ],
        });

        const result = await listRepositoryDirectoryEntries({ sessionId: 's', directoryPath: '' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // NFKC would change 'Å' to 'Å'. We must preserve the raw name.
        expect(result.entries.some((e) => e.name === 'Å.txt')).toBe(true);
        const angular = result.entries.find((e) => e.name === 'Å.txt') ?? null;
        expect(angular?.sizeBytes).toBe(12);
        expect(angular?.modifiedMs).toBe(1700000000000);
    });
});

describe('warmRepositoryDirectoryCache', () => {
    it('dedupes in-flight warms and reuses cached entries across sessions in the same workspace', async () => {
        readMachineTargetForSessionMock.mockImplementation((sessionId: string) => {
            if (sessionId === 's' || sessionId === 's2') return { machineId: 'm1', basePath: '/repo' };
            return { machineId: 'm2', basePath: '/other' };
        });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server');
        sessionListDirectoryMock.mockResolvedValue({
            success: true,
            entries: [
                { name: 'src', type: 'directory' },
                { name: 'a.txt', type: 'file' },
            ],
        });

        let resolve!: (value: any) => void;
        const pending = new Promise((r) => {
            resolve = r as any;
        });

        machineFilesystemListDirectoryMock.mockReturnValueOnce(pending);

        const first = warmRepositoryDirectoryCache({ sessionId: 's', directoryPath: '' });
        const second = warmRepositoryDirectoryCache({ sessionId: 's', directoryPath: '' });

        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledTimes(1);

        resolve({
            ok: true,
            path: '/repo',
            truncated: false,
            entries: [
                { name: 'src', path: '/repo/src', type: 'directory' },
                { name: 'a.txt', path: '/repo/a.txt', type: 'file' },
            ],
        });

        const res1 = await first;
        const res2 = await second;
        expect(res1.ok).toBe(true);
        expect(res2.ok).toBe(true);

        // Subsequent warms should be satisfied from cache without another filesystem list call.
        machineFilesystemListDirectoryMock.mockClear();
        const cached = await warmRepositoryDirectoryCache({ sessionId: 's', directoryPath: '' });
        expect(cached.ok).toBe(true);
        expect(machineFilesystemListDirectoryMock).not.toHaveBeenCalled();

        // A second session attached to the same machine+path should reuse the same cache.
        const cachedSecondSession = await warmRepositoryDirectoryCache({ sessionId: 's2', directoryPath: '' });
        expect(cachedSecondSession.ok).toBe(true);
        expect(machineFilesystemListDirectoryMock).not.toHaveBeenCalled();
    });
});

describe('clearCachedRepositoryDirectoryEntries', () => {
    it('clears all cached directories for a workspace (via a session) without affecting other workspaces', () => {
        readMachineTargetForSessionMock.mockImplementation((sessionId: string) => {
            if (sessionId === 'session-1' || sessionId === 'session-2') return { machineId: 'm1', basePath: '/repo' };
            return { machineId: 'm2', basePath: '/other' };
        });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server');

        setCachedRepositoryDirectoryEntries({
            sessionId: 'session-1',
            directoryPath: '',
            entries: [{ name: 'src', type: 'directory' }],
        });
        setCachedRepositoryDirectoryEntries({
            sessionId: 'session-1',
            directoryPath: 'src',
            entries: [{ name: 'index.ts', type: 'file' }],
        });
        setCachedRepositoryDirectoryEntries({
            sessionId: 'session-2',
            directoryPath: '',
            entries: [{ name: 'README.md', type: 'file' }],
        });

        clearCachedRepositoryDirectoryEntries({ sessionId: 'session-1' });

        expect(getCachedRepositoryDirectoryEntries({ sessionId: 'session-1', directoryPath: '' })).toBeNull();
        expect(getCachedRepositoryDirectoryEntries({ sessionId: 'session-1', directoryPath: 'src' })).toBeNull();
        // session-2 is the same workspace; it should also be cleared.
        expect(getCachedRepositoryDirectoryEntries({ sessionId: 'session-2', directoryPath: '' })).toBeNull();
    });
});
