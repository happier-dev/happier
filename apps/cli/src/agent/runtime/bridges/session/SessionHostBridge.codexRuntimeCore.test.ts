import { describe, expect, it, vi } from 'vitest';

const { runSessionRuntimePlanMock } = vi.hoisted(() => ({
    runSessionRuntimePlanMock: vi.fn(),
}));

vi.mock('@/agent/runtime/session/loop/lifecycle', async (importOriginal) => {
    const actual = await importOriginal<object>();
    return {
        ...actual,
        runHostSessionRuntimePlan: runSessionRuntimePlanMock,
    };
});

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
    resolveBackendExecutionSurfaces: vi.fn(),
    resolveBackendEngineAdapterResolution: vi.fn(async (backendId: string) => {
        const { createCodexRuntimeCore } = await import('@/backends/codex/runtimeCore');
        const runtimeCore = createCodexRuntimeCore({
            backend: { id: 'codex' } as never,
            provider: { id: 'codex' } as never,
        });
        return {
            backendId,
            providerId: 'codex',
            source: 'built_in',
            engineAdapter: {
                runtimeCore: runtimeCore.runtimeCore,
            },
        };
    }),
}));

describe('SessionHostBridge (codex runtimeCore)', () => {
    it('runs Codex session commands through the host-owned session-loop plan', async () => {
        runSessionRuntimePlanMock.mockResolvedValue(undefined);

        const { SessionHostBridge } = await import('./SessionHostBridge');
        const bridge = new SessionHostBridge();
        const credentials = {
            token: 't',
            encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
        };

        await bridge.runSessionCommand('codex', {
            credentials,
            startedBy: 'terminal',
            terminalRuntime: null,
            existingSessionId: 'sid-1',
            resume: 'resume-1',
            startingMode: 'remote',
            codexBackendMode: 'appServer',
        });

        expect(runSessionRuntimePlanMock).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'hostSessionRuntimePlan',
            providerId: 'codex',
            opts: expect.objectContaining({
                credentials,
                existingSessionId: 'sid-1',
                resume: 'resume-1',
                startingMode: 'remote',
                codexBackendMode: 'appServer',
            }),
        }));
    });
});
