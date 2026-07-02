import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveBackendExecutionSurfaces } = vi.hoisted(() => ({
    resolveBackendExecutionSurfaces: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
    resolveBackendExecutionSurfaces,
}));

describe('exportSessionHandoffProviderBundle', () => {
    beforeEach(() => {
        resolveBackendExecutionSurfaces.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
    });

	    it('resolves provider export through the generic backend execution surface for eligible sessions', async () => {
	        const exportBundle = vi.fn(async () => ({
	            ok: true,
	            value: {
	                bundle: {
	                    providerId: 'codex',
	                    remoteSessionId: 'codex_1',
	                    files: [],
	                },
	            },
	        }));
	        resolveBackendExecutionSurfaces.mockResolvedValueOnce({
	            terminalRuntime: null,
	            externalSession: null,
	            attach: null,
	            handoff: {
	                exportBundle,
	                importBundle: vi.fn(),
	            },
	            fork: null,
	            checkpoint: null,
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
            sessionId: 'codex_1',
            metadata: {
                flavor: 'codex',
                machineId: 'machine_source',
	                path: '/repo',
	                codexSessionId: 'codex_1',
	                codexBackendMode: 'appServer',
            },
            directory: '/tmp/server',
        });
    });
});
