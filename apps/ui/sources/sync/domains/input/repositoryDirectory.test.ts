import { describe, expect, it, vi } from 'vitest';

import { listRepositoryDirectoryEntries, sortRepositoryDirectoryEntries } from './repositoryDirectory';

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
                { name: 'Å.txt', type: 'file' },
                { name: 'a.txt', type: 'file' },
            ],
        });

        const result = await listRepositoryDirectoryEntries({ sessionId: 's', directoryPath: '' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // NFKC would change 'Å' to 'Å'. We must preserve the raw name.
        expect(result.entries.some((e) => e.name === 'Å.txt')).toBe(true);
    });
});
