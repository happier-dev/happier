import { describe, expect, it, vi } from 'vitest';

import {
    clearCachedRepositoryDirectoryEntries,
    getCachedRepositoryDirectoryEntries,
    listRepositoryDirectoryEntries,
    setCachedRepositoryDirectoryEntries,
    sortRepositoryDirectoryEntries,
    warmRepositoryDirectoryCache,
} from './repositoryDirectory';

vi.mock('@/sync/ops', () => ({
    sessionListDirectory: vi.fn(),
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
        const { sessionListDirectory } = await import('@/sync/ops');
        (sessionListDirectory as any).mockResolvedValue({
            success: true,
            entries: [
                { name: 'Å.txt', type: 'file', size: 12, modified: 1700000000000 },
                { name: 'a.txt', type: 'file' },
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
    it('dedupes in-flight warms and reuses cached entries', async () => {
        const { sessionListDirectory } = await import('@/sync/ops');

        let resolve!: (value: any) => void;
        const pending = new Promise((r) => {
            resolve = r as any;
        });

        (sessionListDirectory as any).mockReturnValueOnce(pending);

        const first = warmRepositoryDirectoryCache({ sessionId: 's', directoryPath: '' });
        const second = warmRepositoryDirectoryCache({ sessionId: 's', directoryPath: '' });

        expect(sessionListDirectory).toHaveBeenCalledTimes(1);

        resolve({
            success: true,
            entries: [
                { name: 'src', type: 'directory' },
                { name: 'a.txt', type: 'file' },
            ],
        });

        const res1 = await first;
        const res2 = await second;
        expect(res1.ok).toBe(true);
        expect(res2.ok).toBe(true);

        // Subsequent warms should be satisfied from cache without another sessionListDirectory call.
        (sessionListDirectory as any).mockClear();
        const cached = await warmRepositoryDirectoryCache({ sessionId: 's', directoryPath: '' });
        expect(cached.ok).toBe(true);
        expect(sessionListDirectory).not.toHaveBeenCalled();
    });
});

describe('clearCachedRepositoryDirectoryEntries', () => {
    it('clears all cached directories for a session without affecting others', () => {
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
        expect(getCachedRepositoryDirectoryEntries({ sessionId: 'session-2', directoryPath: '' })).toEqual([
            { name: 'README.md', type: 'file' },
        ]);
    });
});
