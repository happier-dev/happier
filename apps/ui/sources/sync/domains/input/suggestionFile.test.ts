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

    it('falls back to directory listing when ripgrep response is malformed', async () => {
        mockSessionRipgrep.mockResolvedValue(null);
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
});
