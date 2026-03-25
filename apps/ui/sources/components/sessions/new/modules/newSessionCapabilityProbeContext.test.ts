import { describe, expect, it, vi } from 'vitest';

describe('resolveNewSessionCapabilityProbeContext (stability)', () => {
    it('returns stable references when runtimeKind is unchanged', async () => {
        vi.resetModules();

        const resolveAgentConfiguredRuntimeKind = vi.fn(() => 'appServer');
        vi.doMock('@happier-dev/agents', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@happier-dev/agents')>();
            return {
                ...actual,
                resolveAgentConfiguredRuntimeKind,
            };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');

        const settings = {} as any;
        const backendTarget = { kind: 'builtInAgent', agentId: 'codex' } as any;

        const first = resolveNewSessionCapabilityProbeContext({ backendTarget, settings });
        const second = resolveNewSessionCapabilityProbeContext({ backendTarget, settings });

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(first).toBe(second);
        expect(first?.cacheKeySuffixParts).toBe(second?.cacheKeySuffixParts);
        expect(first?.capabilityParams).toBe(second?.capabilityParams);
    });

    it('returns new references when runtimeKind changes', async () => {
        vi.resetModules();

        let runtimeKind = 'appServer';
        const resolveAgentConfiguredRuntimeKind = vi.fn(() => runtimeKind);
        vi.doMock('@happier-dev/agents', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@happier-dev/agents')>();
            return {
                ...actual,
                resolveAgentConfiguredRuntimeKind,
            };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');

        const settings = {} as any;
        const backendTarget = { kind: 'builtInAgent', agentId: 'codex' } as any;

        const first = resolveNewSessionCapabilityProbeContext({ backendTarget, settings });
        runtimeKind = 'system';
        const second = resolveNewSessionCapabilityProbeContext({ backendTarget, settings });

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(first).not.toBe(second);
        expect(first?.cacheKeySuffixParts).not.toBe(second?.cacheKeySuffixParts);
        expect(first?.capabilityParams).not.toBe(second?.capabilityParams);
    });
});
