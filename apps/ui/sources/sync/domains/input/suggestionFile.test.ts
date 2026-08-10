import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileSuggestionScope } from './fileSuggestionScope';

const mockMachineRpc = vi.fn();

vi.mock('../../ops', () => {
    throw new Error('suggestionFile must import focused file-search operations instead of the sync ops barrel');
});

vi.mock('@/sync/ops/sessionRipgrep', () => {
    throw new Error('suggestionFile must use focused file-search RPCs instead of session ops');
});

vi.mock('@/sync/ops/sessionFileSystem/directoryBrowsing', () => {
    throw new Error('suggestionFile must use focused file-search RPCs instead of session file-system ops');
});

// File suggestions are addressed by MACHINE + FOLDER, never by session id: a session merely
// *has* a machine and a folder. Rejecting the session-scoped transport here is the pin —
// reintroducing it would route the search through a live session runner again and take
// inactive sessions (and the new-session composer) back to an empty picker.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: () => {
        throw new Error('file suggestions must not use session-scoped RPC');
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: Readonly<{
        machineId: string;
        serverId?: string;
        method: string;
        payload: unknown;
    }>) => mockMachineRpc(params),
}));

const SCOPE: FileSuggestionScope = {
    machineId: 'machine-1',
    path: '/work/repo',
    serverId: 'server-1',
};

function ripgrepCalls(): Array<Readonly<{ args: string[]; cwd?: string }>> {
    return mockMachineRpc.mock.calls
        .map(([params]) => params as Readonly<{ method: string; payload: { args: string[]; cwd?: string } }>)
        .filter((params) => params.method === 'ripgrep')
        .map((params) => params.payload);
}

function listDirectoryPaths(): string[] {
    return mockMachineRpc.mock.calls
        .map(([params]) => params as Readonly<{ method: string; payload: { path: string } }>)
        .filter((params) => params.method === 'listDirectory')
        .map((params) => params.payload.path);
}

describe('searchFiles', () => {
    beforeEach(async () => {
        mockMachineRpc.mockReset();
        const { fileSearchCache } = await import('./suggestionFile');
        fileSearchCache.clearAll();
    });

    it('addresses the machine and folder, never the session', async () => {
        mockMachineRpc.mockResolvedValue({ success: true, stdout: 'README.md\n' });

        const { searchFiles } = await import('./suggestionFile');
        await searchFiles(SCOPE, '', { limit: 10 });

        expect(mockMachineRpc).toHaveBeenCalledTimes(1);
        const params = mockMachineRpc.mock.calls[0]![0] as Readonly<{
            machineId: string;
            serverId?: string;
            method: string;
            payload: { args: string[]; cwd?: string };
        }>;
        expect(params.machineId).toBe('machine-1');
        expect(params.serverId).toBe('server-1');
        expect(params.method).toBe('ripgrep');
        // The folder is the addressing unit: without an explicit cwd the daemon's machine
        // handler would search its own working directory (HOME), not the workspace.
        expect(params.payload.cwd).toBe('/work/repo');
        expect(params.payload.args).toContain('--files');
    });

    it('shares one index between two scopes describing the same machine folder', async () => {
        mockMachineRpc.mockResolvedValue({ success: true, stdout: 'README.md\nsrc/index.ts\n' });

        const { searchFiles } = await import('./suggestionFile');
        await searchFiles(SCOPE, '', { limit: 10 });
        // Same machine + same folder, spelled with a trailing separator. Two sessions on one
        // workspace must not each pay for their own ripgrep index.
        const results = await searchFiles({ ...SCOPE, path: '/work/repo/' }, '', { limit: 10 });

        expect(ripgrepCalls()).toHaveLength(1);
        expect(results.map((entry) => entry.fullPath)).toContain('README.md');
    });

    it('keeps separate indexes for the same folder on different machines', async () => {
        mockMachineRpc.mockResolvedValue({ success: true, stdout: 'README.md\n' });

        const { searchFiles } = await import('./suggestionFile');
        await searchFiles(SCOPE, '', { limit: 10 });
        await searchFiles({ ...SCOPE, machineId: 'machine-2' }, '', { limit: 10 });

        expect(ripgrepCalls()).toHaveLength(2);
        expect(mockMachineRpc.mock.calls[1]![0]).toMatchObject({ machineId: 'machine-2' });
    });

    it('keeps separate indexes for equal machine ids issued by different servers', async () => {
        mockMachineRpc.mockResolvedValue({ success: true, stdout: 'README.md\n' });

        const { searchFiles } = await import('./suggestionFile');
        await searchFiles(SCOPE, '', { limit: 10 });
        await searchFiles({ ...SCOPE, serverId: 'server-2' }, '', { limit: 10 });

        expect(ripgrepCalls()).toHaveLength(2);
        expect(mockMachineRpc.mock.calls[1]![0]).toMatchObject({
            machineId: 'machine-1',
            serverId: 'server-2',
        });
    });

    it('clears only the scope it is asked to clear', async () => {
        mockMachineRpc.mockResolvedValue({ success: true, stdout: 'README.md\n' });

        const { searchFiles, fileSearchCache } = await import('./suggestionFile');
        const other: FileSuggestionScope = { ...SCOPE, path: '/work/other' };
        await searchFiles(SCOPE, '', { limit: 10 });
        await searchFiles(other, '', { limit: 10 });
        expect(ripgrepCalls()).toHaveLength(2);

        fileSearchCache.clearCache(SCOPE);
        await searchFiles(other, '', { limit: 10 });
        expect(ripgrepCalls()).toHaveLength(2);

        await searchFiles(SCOPE, '', { limit: 10 });
        expect(ripgrepCalls()).toHaveLength(3);
    });

    it('falls back to directory listing when ripgrep fails, addressing folders absolutely', async () => {
        mockMachineRpc.mockImplementation((params: Readonly<{ method: string; payload: { path?: string } }>) => {
            if (params.method === 'ripgrep') return Promise.reject(new Error('ripgrep unavailable'));
            if (params.payload.path === '/work/repo') {
                return Promise.resolve({
                    success: true,
                    entries: [
                        { name: 'src', type: 'directory' },
                        { name: 'README.md', type: 'file' },
                    ],
                });
            }
            if (params.payload.path === '/work/repo/src') {
                return Promise.resolve({ success: true, entries: [{ name: 'index.ts', type: 'file' }] });
            }
            return Promise.resolve({ success: false, error: 'Path is required' });
        });

        const { searchFiles } = await import('./suggestionFile');
        const results = await searchFiles(SCOPE, '', { limit: 10 });

        // The daemon rejects an empty path before it ever consults its default directory
        // (`resolveFilesystemTargetPath`: "Path is required"), so the walk must send the
        // scope root absolutely. Sending '' is what made this fallback dead code.
        expect(listDirectoryPaths()).toContain('/work/repo');
        expect(listDirectoryPaths()).toContain('/work/repo/src');
        expect(listDirectoryPaths()).not.toContain('');
        // Rows stay RELATIVE to the scope root, because that is what the composer inserts.
        expect(results.map((entry) => entry.fullPath)).toContain('README.md');
        expect(results.map((entry) => entry.fullPath)).toContain('src/');
        expect(results.map((entry) => entry.fullPath)).toContain('src/index.ts');
    });

    it('uses ripgrep results directly when available', async () => {
        mockMachineRpc.mockResolvedValue({
            success: true,
            stdout: 'README.md\nsrc/index.ts\n',
        });

        const { searchFiles } = await import('./suggestionFile');
        const results = await searchFiles(SCOPE, '', { limit: 10 });

        expect(listDirectoryPaths()).toHaveLength(0);
        expect(results.map((entry) => entry.fullPath)).toContain('README.md');
        expect(results.map((entry) => entry.fullPath)).toContain('src/index.ts');
        expect(results.map((entry) => entry.fullPath)).toContain('src/');
    });

    it('matches hyphenated filenames and extensions', async () => {
        mockMachineRpc.mockResolvedValue({
            success: true,
            stdout: [
                '.github/workflows/publish-github-release.yml',
                '.github/workflows/tests.yml',
                'src/index.ts',
            ].join('\n') + '\n',
        });

        const { searchFiles } = await import('./suggestionFile');

        const results = await searchFiles(SCOPE, 'publish-github-release', { limit: 50 });
        expect(results.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);

        const resultsWithExt = await searchFiles(SCOPE, 'publish-github-release.yml', { limit: 50 });
        expect(resultsWithExt.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);
    });

    it('falls back to ripgrep glob search when the initial file index misses a match', async () => {
        mockMachineRpc
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

        const results = await searchFiles(SCOPE, 'publish-github-release', { limit: 50 });
        expect(results.some((entry) => entry.fullPath === '.github/workflows/publish-github-release.yml')).toBe(true);

        const calls = ripgrepCalls();
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls[1]?.args).toContain('--files');
        expect(calls[1]?.args).toContain('--iglob');
        // The targeted glob must stay inside the addressed folder too.
        expect(calls[1]?.cwd).toBe('/work/repo');
    });
});
