import { describe, expect, it, vi } from 'vitest';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';

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

    it('adds selected Claude subscription bindings only to the model probe and partitions its cache identity', async () => {
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
        const backendTarget = { kind: 'builtInAgent', agentId: 'claude' } as any;
        const firstConnectedServices = ConnectedServiceBindingsV1Schema.parse({
            v: 1,
            bindingsByServiceId: {
                'claude-subscription': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                },
            },
        });
        const secondConnectedServices = ConnectedServiceBindingsV1Schema.parse({
            v: 1,
            bindingsByServiceId: {
                'claude-subscription': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'personal',
                },
            },
        });

        const firstInput = {
            backendTarget,
            settings,
            connectedServices: firstConnectedServices,
        };
        const secondInput = {
            backendTarget,
            settings,
            connectedServices: secondConnectedServices,
        };
        const { resolveNewSessionModelCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        const shared = resolveNewSessionCapabilityProbeContext(firstInput);
        const first = resolveNewSessionModelCapabilityProbeContext(firstInput);
        const second = resolveNewSessionModelCapabilityProbeContext(secondInput);

        expect(shared).toEqual({
            cacheKeySuffixParts: ['appServer'],
            capabilityParams: { runtimeKindOverride: 'appServer' },
        });
        expect(shared?.capabilityParams).not.toHaveProperty('connectedServices');
        expect(first?.capabilityParams).toEqual({
            runtimeKindOverride: 'appServer',
            connectedServices: firstConnectedServices,
        });
        expect(first?.cacheKeySuffixParts).toContain('claude-subscription:profile:work');
        expect(second?.cacheKeySuffixParts).toContain('claude-subscription:profile:personal');
        expect(second).not.toBe(first);
    });

    it('mints a model-only Claude observation context from a selected binding while native or unrelated selections stay omitted', async () => {
        vi.resetModules();

        const resolveAgentConfiguredRuntimeKind = vi.fn(() => null);
        vi.doMock('@happier-dev/agents', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@happier-dev/agents')>();
            return {
                ...actual,
                resolveAgentConfiguredRuntimeKind,
            };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        const input = {
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as any,
            settings: {} as any,
            connectedServices: ConnectedServiceBindingsV1Schema.parse({
                v: 1,
                bindingsByServiceId: {
                    'claude-subscription': { source: 'connected', selection: 'group', groupId: 'team' },
                },
            }),
        };

        const { resolveNewSessionModelCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        expect(resolveNewSessionCapabilityProbeContext(input)).toBeNull();
        expect(resolveNewSessionModelCapabilityProbeContext(input)).toEqual({
            cacheKeySuffixParts: ['claude-subscription:group:team'],
            capabilityParams: { connectedServices: input.connectedServices },
            modelSuccessCacheMaxAgeMs: 5 * 60_000,
        });
        expect(resolveNewSessionModelCapabilityProbeContext({
            ...input,
            connectedServices: ConnectedServiceBindingsV1Schema.parse({
                v: 1,
                bindingsByServiceId: { 'claude-subscription': { source: 'native' } },
            }),
        })).toBeNull();
    });
});
