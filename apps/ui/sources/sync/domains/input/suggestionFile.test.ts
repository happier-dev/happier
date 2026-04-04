import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRipgrepMock = vi.fn();
const machineFilesystemListDirectoryMock = vi.fn();
const readMachineTargetForSessionMock = vi.fn();
const resolvePreferredServerIdForSessionIdMock = vi.fn();

vi.mock('@/sync/ops/machineRipgrep', () => ({
    machineRipgrep: (...args: unknown[]) => machineRipgrepMock(...args),
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

describe('searchFiles', () => {
    beforeEach(async () => {
        machineRipgrepMock.mockReset();
        machineFilesystemListDirectoryMock.mockReset();
        readMachineTargetForSessionMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        const { fileSearchCache } = await import('./suggestionFile');
        fileSearchCache.clearCache();
    });

    it('falls back to directory listing when ripgrep fails', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'm1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server');

        machineRipgrepMock.mockRejectedValue(new Error('ripgrep unavailable'));

        // Directory fallback should enumerate the repo root and `src`.
        machineFilesystemListDirectoryMock
            .mockResolvedValueOnce({
                ok: true,
                path: '/repo',
                truncated: false,
                entries: [
                    { name: 'src', path: '/repo/src', type: 'directory' },
                    { name: 'README.md', path: '/repo/README.md', type: 'file' },
                ],
            })
            .mockResolvedValueOnce({
                ok: true,
                path: '/repo/src',
                truncated: false,
                entries: [
                    { name: 'index.ts', path: '/repo/src/index.ts', type: 'file' },
                ],
            });

        const { searchFiles } = await import('./suggestionFile');
        const results = await searchFiles('session-1', '', { limit: 10 });

        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledWith(
            'm1',
            { path: '/repo', includeFiles: true },
            { serverId: 'server' },
        );
        expect(machineFilesystemListDirectoryMock).toHaveBeenCalledWith(
            'm1',
            { path: '/repo/src', includeFiles: true },
            { serverId: 'server' },
        );
        expect(results.map((entry) => entry.fullPath)).toContain('README.md');
        expect(results.map((entry) => entry.fullPath)).toContain('src/');
        expect(results.map((entry) => entry.fullPath)).toContain('src/index.ts');
    });

    it('uses ripgrep results directly when available', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'm1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server');

        machineRipgrepMock.mockResolvedValue({
            success: true,
            stdout: 'README.md\nsrc/index.ts\n',
            stderr: '',
            exitCode: 0,
        });

        const { searchFiles } = await import('./suggestionFile');
        const results = await searchFiles('session-1', '', { limit: 10 });

        expect(machineFilesystemListDirectoryMock).not.toHaveBeenCalled();
        expect(results.map((entry) => entry.fullPath)).toContain('README.md');
        expect(results.map((entry) => entry.fullPath)).toContain('src/index.ts');
        expect(results.map((entry) => entry.fullPath)).toContain('src/');
    });

    it('matches hyphenated filenames and extensions', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'm1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server');

        machineRipgrepMock.mockResolvedValue({
            success: true,
            stdout: [
                '.github/workflows/publish-github-release.yml',
                '.github/workflows/tests.yml',
                'src/index.ts',
            ].join('\n') + '\n',
            stderr: '',
            exitCode: 0,
        });

        const { searchFiles } = await import('./suggestionFile');

        const results = await searchFiles('session-1', 'publish-github-release', { limit: 50 });
        expect(results.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);

        const resultsWithExt = await searchFiles('session-1', 'publish-github-release.yml', { limit: 50 });
        expect(resultsWithExt.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);
    });

    it('falls back to ripgrep glob search when the initial file index misses a match', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'm1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server');

        machineRipgrepMock
            .mockResolvedValueOnce({
                success: true,
                stdout: [
                    '.github/workflows/tests.yml',
                    'src/index.ts',
                ].join('\n') + '\n',
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                success: true,
                stdout: '.github/workflows/publish-github-release.yml\n',
                stderr: '',
                exitCode: 0,
            });

        const { searchFiles } = await import('./suggestionFile');

        const results = await searchFiles('session-1', 'publish-github-release', { limit: 50 });
        expect(results.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);

        // Ensure we actually attempted a targeted ripgrep request.
        expect(machineRipgrepMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        const secondArgs = machineRipgrepMock.mock.calls[1]?.[1] as string[] | undefined;
        expect(secondArgs).toContain('--files');
        expect(secondArgs).toContain('--iglob');
    });

    it('reuses the file index across sessions in the same workspace', async () => {
        readMachineTargetForSessionMock.mockImplementation((sessionId: string) => {
            if (sessionId === 'session-1' || sessionId === 'session-2') return { machineId: 'm1', basePath: '/repo' };
            return { machineId: 'm2', basePath: '/other' };
        });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server');

        machineRipgrepMock.mockResolvedValue({
            success: true,
            stdout: 'README.md\nsrc/index.ts\n',
            stderr: '',
            exitCode: 0,
        });

        const { searchFiles } = await import('./suggestionFile');
        await searchFiles('session-1', '', { limit: 10 });
        await searchFiles('session-2', '', { limit: 10 });

        expect(machineRipgrepMock).toHaveBeenCalledTimes(1);
    });

    it('returns no results without falling back to a machine-only cache key when no preferred server is available', async () => {
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'm1', basePath: '/repo' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(null);

        const { searchFiles } = await import('./suggestionFile');
        await expect(searchFiles('session-1', '', { limit: 10 })).resolves.toEqual([]);

        expect(machineRipgrepMock).not.toHaveBeenCalled();
        expect(machineFilesystemListDirectoryMock).not.toHaveBeenCalled();
    });
});
