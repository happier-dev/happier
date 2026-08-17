import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRipgrepMock = vi.fn();
const machineFilesystemListDirectoryMock = vi.fn();
const resolveWorkspaceTargetForSessionMock = vi.fn();

vi.mock('@/sync/ops/machineRipgrep', () => ({
    machineRipgrep: (...args: unknown[]) => machineRipgrepMock(...args),
}));

vi.mock('@/sync/ops/machineFileBrowser', () => ({
    machineFilesystemListDirectory: (...args: unknown[]) => machineFilesystemListDirectoryMock(...args),
}));

vi.mock('@/sync/domains/session/resolveWorkspaceTargetForSession', () => ({
    resolveWorkspaceTargetForSession: (...args: unknown[]) => resolveWorkspaceTargetForSessionMock(...args),
}));

const SCOPE_A = { serverId: 'server', machineId: 'm1', rootPath: '/repo' } as const;

describe('searchFiles', () => {
    beforeEach(async () => {
        vi.resetModules();
        machineRipgrepMock.mockReset();
        machineFilesystemListDirectoryMock.mockReset();
        resolveWorkspaceTargetForSessionMock.mockReset();
        const { fileSearchCache } = await import('./suggestionFile');
        fileSearchCache.clearCache();
    });

    it('falls back to directory listing when ripgrep fails', async () => {
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
        const results = await searchFiles(SCOPE_A, '', { limit: 10 });

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
        machineRipgrepMock.mockResolvedValue({
            success: true,
            stdout: 'README.md\nsrc/index.ts\n',
            stderr: '',
            exitCode: 0,
        });

        const { searchFiles } = await import('./suggestionFile');
        const results = await searchFiles(SCOPE_A, '', { limit: 10 });

        expect(machineFilesystemListDirectoryMock).not.toHaveBeenCalled();
        expect(results.map((entry) => entry.fullPath)).toContain('README.md');
        expect(results.map((entry) => entry.fullPath)).toContain('src/index.ts');
        expect(results.map((entry) => entry.fullPath)).toContain('src/');
    });

    it('matches hyphenated filenames and extensions', async () => {
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

        const results = await searchFiles(SCOPE_A, 'publish-github-release', { limit: 50 });
        expect(results.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);

        const resultsWithExt = await searchFiles(SCOPE_A, 'publish-github-release.yml', { limit: 50 });
        expect(resultsWithExt.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);
    });

    it('falls back to ripgrep glob search when the initial file index misses a match', async () => {
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

        const results = await searchFiles(SCOPE_A, 'publish-github-release', { limit: 50 });
        expect(results.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);

        // Ensure we actually attempted a targeted ripgrep request.
        expect(machineRipgrepMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        const secondArgs = machineRipgrepMock.mock.calls[1]?.[1] as string[] | undefined;
        expect(secondArgs).toContain('--files');
        expect(secondArgs).toContain('--iglob');
    });

    /**
     * The index identity is the workspace, so two composers on one folder must share it and
     * two on different folders must not collide. Both halves are asserted together: a key that
     * ignored the folder would pass the sharing half alone, and a key that included something
     * per-composer would pass the isolation half alone.
     */
    it('shares one file index per workspace and never across workspaces', async () => {
        const scopeSameFolderOtherSpelling = { serverId: 'server', machineId: 'm1', rootPath: '/repo/' } as const;
        const scopeOtherFolder = { serverId: 'server', machineId: 'm1', rootPath: '/other' } as const;
        const scopeOtherMachine = { serverId: 'server', machineId: 'm2', rootPath: '/repo' } as const;

        machineRipgrepMock.mockImplementation(async (_machineId: string, _args: string[], cwd: string) => ({
            success: true,
            stdout: cwd === '/repo' ? 'README.md\nsrc/index.ts\n' : 'OTHER.md\n',
            stderr: '',
            exitCode: 0,
        }));

        const { searchFiles } = await import('./suggestionFile');

        const first = await searchFiles(SCOPE_A, '', { limit: 10 });
        expect(first.some((entry) => entry.fullPath === 'README.md')).toBe(true);

        // Same folder, second composer: served from the existing index, no second ripgrep.
        await searchFiles({ ...SCOPE_A }, '', { limit: 10 });
        // A trailing separator is spelling, not identity.
        await searchFiles(scopeSameFolderOtherSpelling, '', { limit: 10 });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(1);

        // A different folder on the same machine is a different index, and must return ITS
        // files — not the first folder's, which is what a collision would look like.
        const otherFolder = await searchFiles(scopeOtherFolder, '', { limit: 10 });
        expect(otherFolder.some((entry) => entry.fullPath === 'OTHER.md')).toBe(true);
        expect(otherFolder.some((entry) => entry.fullPath === 'README.md')).toBe(false);
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);

        // The same folder path on a different machine is likewise a different index.
        await searchFiles(scopeOtherMachine, '', { limit: 10 });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(3);
        expect(machineRipgrepMock.mock.calls.map((call) => [call[0], call[2]])).toEqual([
            ['m1', '/repo'],
            ['m1', '/other'],
            ['m2', '/repo'],
        ]);
    });

    it('searches nothing when the composer has no workspace to address', async () => {
        const { searchFiles } = await import('./suggestionFile');
        await expect(searchFiles(null, '', { limit: 10 })).resolves.toEqual([]);

        expect(machineRipgrepMock).not.toHaveBeenCalled();
        expect(machineFilesystemListDirectoryMock).not.toHaveBeenCalled();
    });

    /**
     * A partial scope must fail closed. Passing it through would send ripgrep no `cwd`, and the
     * daemon would then search its OWN working directory (HOME) and offer files from an
     * unrelated tree — a wrong answer, not a narrower one.
     */
    it('searches nothing when the workspace address is incomplete', async () => {
        const { searchFiles } = await import('./suggestionFile');
        await expect(searchFiles({ serverId: 'server', machineId: 'm1', rootPath: '   ' }, '', { limit: 10 })).resolves.toEqual([]);
        await expect(searchFiles({ serverId: 'server', machineId: '', rootPath: '/repo' }, '', { limit: 10 })).resolves.toEqual([]);
        await expect(searchFiles({ serverId: '', machineId: 'm1', rootPath: '/repo' }, '', { limit: 10 })).resolves.toEqual([]);

        expect(machineRipgrepMock).not.toHaveBeenCalled();
        expect(machineFilesystemListDirectoryMock).not.toHaveBeenCalled();
    });

    it('clears the index for the workspace a session sits in, and never every workspace', async () => {
        machineRipgrepMock.mockResolvedValue({
            success: true,
            stdout: 'README.md\n',
            stderr: '',
            exitCode: 0,
        });
        resolveWorkspaceTargetForSessionMock.mockReturnValue({
            workspaceCacheKey: 'server:m1:/repo',
            machineId: 'm1',
            rootPath: '/repo',
            serverId: 'server',
        });

        const { searchFiles, fileSearchCache } = await import('./suggestionFile');
        await searchFiles(SCOPE_A, '', { limit: 10 });
        await searchFiles({ serverId: 'server', machineId: 'm1', rootPath: '/other' }, '', { limit: 10 });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);

        fileSearchCache.clearCache('session-1');

        // Only the cleared session's folder re-indexes; the untouched one is still cached.
        await searchFiles({ serverId: 'server', machineId: 'm1', rootPath: '/other' }, '', { limit: 10 });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
        await searchFiles(SCOPE_A, '', { limit: 10 });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(3);
    });

    it('clears nothing when the session addresses no workspace', async () => {
        machineRipgrepMock.mockResolvedValue({
            success: true,
            stdout: 'README.md\n',
            stderr: '',
            exitCode: 0,
        });
        resolveWorkspaceTargetForSessionMock.mockReturnValue(null);

        const { searchFiles, fileSearchCache } = await import('./suggestionFile');
        await searchFiles(SCOPE_A, '', { limit: 10 });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(1);

        fileSearchCache.clearCache('session-with-no-workspace');

        // An unresolvable session must not fall through to wiping every workspace's index.
        await searchFiles(SCOPE_A, '', { limit: 10 });
        expect(machineRipgrepMock).toHaveBeenCalledTimes(1);
    });
});
