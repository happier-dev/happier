import { describe, expect, it, vi } from 'vitest';

const machineScmDiffFileMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: (...args: unknown[]) => machineScmDiffFileMock(...args),
}));

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceReadFile: vi.fn(),
}));

describe('fetchWorkspaceUnifiedDiffForPath', () => {
    it('keeps workspace server scope when requesting a machine SCM file diff', async () => {
        machineScmDiffFileMock.mockResolvedValue({
            success: true,
            diff: '',
        });

        const { fetchWorkspaceUnifiedDiffForPath } = await import('./fetchWorkspaceUnifiedDiffForPath');
        const response = await fetchWorkspaceUnifiedDiffForPath({
            scope: {
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: '/repo',
            },
            diffArea: 'pending',
            path: 'src/app.ts',
            file: null,
            normalizeError: (input) => String(input),
            fallbackError: 'Failed to load diff',
        });

        expect(response).toEqual({ success: true, diff: '' });
        expect(machineScmDiffFileMock).toHaveBeenCalledWith(
            'machine-a',
            {
                cwd: '/repo',
                path: 'src/app.ts',
                area: 'pending',
            },
            { serverId: 'server-a' },
        );
    });
});
