import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRipgrepMock = vi.fn();

vi.mock('@/sync/ops/machineRipgrep', () => ({
    machineRipgrep: (...args: unknown[]) => machineRipgrepMock(...args),
}));

describe('workspaceFileSearch', () => {
    beforeEach(() => {
        vi.resetModules();
        machineRipgrepMock.mockReset();
    });

    it('indexes files via ripgrep and caches per workspaceCacheKey', async () => {
        machineRipgrepMock.mockResolvedValue({
            success: true,
            stdout: 'src/a.ts\nREADME.md\n',
            stderr: '',
            exitCode: 0,
        });

        const mod = await import('./workspaceFileSearch');

        const resA1 = await mod.searchWorkspaceFiles({
            workspaceCacheKey: 'ws-a',
            machineId: 'm1',
            rootPath: '/repo',
            query: 'a',
            limit: 50,
        });
        expect(resA1.some((r) => r.fullPath === 'src/a.ts')).toBe(true);

        const resA2 = await mod.searchWorkspaceFiles({
            workspaceCacheKey: 'ws-a',
            machineId: 'm1',
            rootPath: '/repo',
            query: 'readme',
            limit: 50,
        });
        expect(resA2.some((r) => r.fullPath === 'README.md')).toBe(true);

        // Same workspace should not re-index twice in a row.
        expect(machineRipgrepMock).toHaveBeenCalledTimes(1);

        const resB = await mod.searchWorkspaceFiles({
            workspaceCacheKey: 'ws-b',
            machineId: 'm1',
            rootPath: '/repo',
            query: 'a',
            limit: 50,
        });
        expect(resB.some((r) => r.fullPath === 'src/a.ts')).toBe(true);
        expect(machineRipgrepMock).toHaveBeenCalledTimes(2);
    });
});
