import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSessionRipgrep = vi.fn();
const mockSessionListDirectory = vi.fn();

vi.mock('../../ops', () => ({
    sessionRipgrep: (...args: unknown[]) => mockSessionRipgrep(...args),
    sessionListDirectory: (...args: unknown[]) => mockSessionListDirectory(...args),
}));

describe('searchFiles', () => {
    beforeEach(async () => {
        mockSessionRipgrep.mockReset();
        mockSessionListDirectory.mockReset();
        const { fileSearchCache } = await import('./suggestionFile');
        fileSearchCache.clearCache();
    });

    it('falls back to directory listing when ripgrep fails', async () => {
        mockSessionRipgrep.mockRejectedValue(new Error('ripgrep unavailable'));
        mockSessionListDirectory
            .mockResolvedValueOnce({
                success: true,
                entries: [
                    { name: 'src', type: 'directory' },
                    { name: 'README.md', type: 'file' },
                ],
            })
            .mockResolvedValueOnce({
                success: true,
                entries: [
                    { name: 'index.ts', type: 'file' },
                ],
            });

        const { searchFiles } = await import('./suggestionFile');
        const results = await searchFiles('session-1', '', { limit: 10 });

        expect(mockSessionListDirectory).toHaveBeenCalledWith('session-1', '');
        expect(mockSessionListDirectory).toHaveBeenCalledWith('session-1', 'src');
        expect(results.map((entry) => entry.fullPath)).toContain('README.md');
        expect(results.map((entry) => entry.fullPath)).toContain('src/');
        expect(results.map((entry) => entry.fullPath)).toContain('src/index.ts');
    });

    it('uses ripgrep results directly when available', async () => {
        mockSessionRipgrep.mockResolvedValue({
            success: true,
            stdout: 'README.md\nsrc/index.ts\n',
        });

        const { searchFiles } = await import('./suggestionFile');
        const results = await searchFiles('session-1', '', { limit: 10 });

        expect(mockSessionListDirectory).not.toHaveBeenCalled();
        expect(results.map((entry) => entry.fullPath)).toContain('README.md');
        expect(results.map((entry) => entry.fullPath)).toContain('src/index.ts');
        expect(results.map((entry) => entry.fullPath)).toContain('src/');
    });

    it('matches hyphenated filenames and extensions', async () => {
        mockSessionRipgrep.mockResolvedValue({
            success: true,
            stdout: [
                '.github/workflows/publish-github-release.yml',
                '.github/workflows/tests.yml',
                'src/index.ts',
            ].join('\n') + '\n',
        });

        const { searchFiles } = await import('./suggestionFile');

        const results = await searchFiles('session-1', 'publish-github-release', { limit: 50 });
        expect(results.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);

        const resultsWithExt = await searchFiles('session-1', 'publish-github-release.yml', { limit: 50 });
        expect(resultsWithExt.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);
    });

    it('falls back to ripgrep glob search when the initial file index misses a match', async () => {
        mockSessionRipgrep
            .mockResolvedValueOnce({
                success: true,
                stdout: [
                    '.github/workflows/tests.yml',
                    'src/index.ts',
                ].join('\n') + '\n',
            })
            .mockResolvedValueOnce({
                success: true,
                stdout: '.github/workflows/publish-github-release.yml\n',
            });

        const { searchFiles } = await import('./suggestionFile');

        const results = await searchFiles('session-1', 'publish-github-release', { limit: 50 });
        expect(results.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);

        // Ensure we actually attempted a targeted ripgrep request.
        expect(mockSessionRipgrep.mock.calls.length).toBeGreaterThanOrEqual(2);
        const secondArgs = mockSessionRipgrep.mock.calls[1]?.[1] as string[] | undefined;
        expect(secondArgs).toContain('--files');
        expect(secondArgs).toContain('--iglob');
    });
});
