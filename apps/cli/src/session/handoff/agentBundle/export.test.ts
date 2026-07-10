import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveExecutionSurfaces, resolveSessionHandoffEligibility } = vi.hoisted(() => ({
    resolveExecutionSurfaces: vi.fn(),
    resolveSessionHandoffEligibility: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
    getSessionHostBridge: () => ({
        resolveExecutionSurfaces,
        resolveSessionHandoffEligibility,
    }),
}));

describe('exportSessionHandoffAgentBundle', () => {
    beforeEach(() => {
        resolveExecutionSurfaces.mockReset();
        resolveSessionHandoffEligibility.mockReset();
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
        resolveSessionHandoffEligibility.mockReturnValueOnce({
            eligible: true,
            agentId: 'codex',
            vendorHandoffId: 'codex_1',
        });
        resolveExecutionSurfaces.mockResolvedValueOnce({
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
        const { exportSessionHandoffAgentBundle } = await import('./export');

        await expect(exportSessionHandoffAgentBundle({
            metadata: {
                flavor: 'codex',
                machineId: 'machine_source',
                path: '/repo',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
            },
            activeServerDir: '/tmp/server',
        })).resolves.toEqual({
            agentBundle: {
                providerId: 'codex',
                remoteSessionId: 'codex_1',
                files: [],
            },
            targetPath: '/repo',
        });

        expect(resolveSessionHandoffEligibility).toHaveBeenCalledWith({
            metadata: {
                flavor: 'codex',
                machineId: 'machine_source',
                path: '/repo',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
            },
        });
        expect(resolveExecutionSurfaces).toHaveBeenCalledWith('codex');
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
