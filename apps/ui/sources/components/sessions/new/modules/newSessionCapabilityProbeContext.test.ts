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

    it('returns null for plugin backend targets (no built-in runtimeKind probing)', async () => {
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
        const backendTarget = { kind: 'builtInAgent', agentId: 'acme.review.backend' } as any;

        expect(resolveNewSessionCapabilityProbeContext({ backendTarget, settings })).toBeNull();
        expect(resolveAgentConfiguredRuntimeKind).toHaveBeenCalledTimes(0);
    });

    it('uses the projected runtime carrier for plugin backend targets when available', async () => {
        vi.resetModules();

        const resolveAgentConfiguredRuntimeKind = vi.fn(() => 'claude-code');
        vi.doMock('@happier-dev/agents', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@happier-dev/agents')>();
            return {
                ...actual,
                resolveAgentConfiguredRuntimeKind,
            };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');

        const settings = {} as any;
        const backendTarget = { kind: 'builtInAgent', agentId: 'acme.review.backend' } as any;

        const context = resolveNewSessionCapabilityProbeContext({
            backendTarget,
            settings,
            runtimeCarrierAgentId: 'claude',
        });

        expect(context).toEqual({
            cacheKeySuffixParts: ['claude-code'],
            capabilityParams: { runtimeKindOverride: 'claude-code' },
        });
        expect(resolveAgentConfiguredRuntimeKind).toHaveBeenCalledWith({
            agentId: 'claude',
            accountSettings: settings,
        });
    });

    it('includes connected-service bindings in capability params and cache identity', async () => {
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
        const connectedServices = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                },
            },
        };

        const context = resolveNewSessionCapabilityProbeContext({
            backendTarget,
            settings,
            connectedServices,
        });

        expect(context).toEqual({
            cacheKeySuffixParts: [
                'runtime:appServer',
                'connectedServices:{"bindingsByServiceId":{"openai-codex":{"profileId":"work","selection":"profile","source":"connected"}},"v":1}',
            ],
            capabilityParams: {
                runtimeKindOverride: 'appServer',
                connectedServices,
            },
        });
    });
});
