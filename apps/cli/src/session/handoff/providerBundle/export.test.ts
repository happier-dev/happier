import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveBackendExecutionSurfaces, directCodexExportBundle } = vi.hoisted(() => ({
    resolveBackendExecutionSurfaces: vi.fn(),
    directCodexExportBundle: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
    resolveBackendExecutionSurfaces,
}));

vi.mock('../../backends/codex/handoff/exportCodexSessionBundle', () => ({
    exportCodexSessionBundle: directCodexExportBundle,
}));

describe('exportSessionHandoffProviderBundle', () => {
    beforeEach(() => {
        resolveBackendExecutionSurfaces.mockReset();
        directCodexExportBundle.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('resolves provider export through the generic backend execution surface for eligible sessions', async () => {
        const exportBundle = vi.fn(async () => ({
            providerId: 'codex',
            remoteSessionId: 'codex_1',
            files: [],
        }));
        resolveBackendExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            directSessions: null,
            attach: null,
            sessionHandoff: {
                exportBundle,
                importBundle: vi.fn(),
            },
        });
        directCodexExportBundle.mockImplementation(() => {
            throw new Error('direct codex export should not be called');
        });

        const { exportSessionHandoffProviderBundle } = await import('./export');

        await expect(exportSessionHandoffProviderBundle({
            metadata: {
                flavor: 'codex',
                machineId: 'machine_source',
                path: '/repo',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
            },
            activeServerDir: '/tmp/server',
        })).resolves.toEqual({
            providerBundle: {
                providerId: 'codex',
                remoteSessionId: 'codex_1',
                files: [],
            },
            targetPath: '/repo',
        });

        expect(resolveBackendExecutionSurfaces).toHaveBeenCalledWith('codex');
        expect(exportBundle).toHaveBeenCalledWith({
            metadata: {
                flavor: 'codex',
                machineId: 'machine_source',
                path: '/repo',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
            },
            remoteSessionId: 'codex_1',
            activeServerDir: '/tmp/server',
        });
        expect(directCodexExportBundle).not.toHaveBeenCalled();
    });
});
