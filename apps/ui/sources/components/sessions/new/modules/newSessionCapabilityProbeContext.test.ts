import { describe, expect, it, vi } from 'vitest';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';

describe('resolveNewSessionCapabilityProbeContext (stability)', () => {
    it('returns stable references when runtimeKind is unchanged', async () => {
        vi.resetModules();

        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => 'appServer');
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
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
        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => runtimeKind);
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
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

        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => 'appServer');
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');

        const settings = {} as any;
        const backendTarget = { kind: 'builtInAgent', agentId: 'acme.review.backend' } as any;

        expect(resolveNewSessionCapabilityProbeContext({ backendTarget, settings })).toBeNull();
        expect(resolveConfiguredAgentRuntimeKindFromUiBehavior).toHaveBeenCalledTimes(0);
    });

    it('uses the projected runtime carrier for plugin backend targets when available', async () => {
        vi.resetModules();

        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => 'claude-code');
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
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
            capabilityParams: {},
        });
        expect(resolveConfiguredAgentRuntimeKindFromUiBehavior).toHaveBeenCalledWith({
            agentId: 'claude',
            settings: expect.any(Object),
        });
    });

    it('adds selected Claude subscription bindings only to the model probe and partitions its cache identity', async () => {
        vi.resetModules();

        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => 'appServer');
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');

        const settings = {} as any;
        const backendTarget = { kind: 'builtInAgent', agentId: 'claude' } as any;
        // Canonical bindings are keyed by the qualified service key; the bundled
        // `claude-subscription` observation must translate through the legacy
        // ingress before lookup and cache identity.
        const CLAUDE_SUBSCRIPTION_SERVICE_KEY = 'happier.agent.claude/claude-subscription';
        const firstConnectedServices = ConnectedServiceBindingsV1Schema.parse({
            v: 1,
            bindingsByServiceId: {
                [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                },
            },
        });
        const secondConnectedServices = ConnectedServiceBindingsV1Schema.parse({
            v: 1,
            bindingsByServiceId: {
                [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: {
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
            capabilityParams: {},
        });
        expect(shared?.capabilityParams).not.toHaveProperty('connectedServices');
        expect(first?.capabilityParams).toEqual({
            connectedServices: firstConnectedServices,
        });
        expect(first?.cacheKeySuffixParts).toContain(`${CLAUDE_SUBSCRIPTION_SERVICE_KEY}:profile:work`);
        expect(second?.cacheKeySuffixParts).toContain(`${CLAUDE_SUBSCRIPTION_SERVICE_KEY}:profile:personal`);
        expect(second).not.toBe(first);
    });

    it('translates the bundled scalar observation id to the canonical qualified binding key', async () => {
        vi.resetModules();

        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => null);
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
        });

        const { resolveNewSessionModelCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        const input = {
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as any,
            settings: {} as any,
            // The released bundled model-config author fact carries the scalar
            // id; the canonical binding payload carries the qualified key.
            connectedServices: ConnectedServiceBindingsV1Schema.parse({
                v: 1,
                bindingsByServiceId: {
                    'happier.agent.claude/claude-subscription': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'team',
                    },
                },
            }),
        };

        const context = resolveNewSessionModelCapabilityProbeContext(input);
        expect(context).toEqual({
            cacheKeySuffixParts: ['happier.agent.claude/claude-subscription:group:team'],
            capabilityParams: { connectedServices: input.connectedServices },
            modelSuccessCacheMaxAgeMs: 5 * 60_000,
        });
    });

    it('mints a model-only Claude observation context from a selected binding while native or unrelated selections stay omitted', async () => {
        vi.resetModules();

        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => null);
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        const input = {
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as any,
            settings: {} as any,
            connectedServices: ConnectedServiceBindingsV1Schema.parse({
                v: 1,
                bindingsByServiceId: {
                    'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'group', groupId: 'team' },
                },
            }),
        };

        const { resolveNewSessionModelCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        expect(resolveNewSessionCapabilityProbeContext(input)).toBeNull();
        expect(resolveNewSessionModelCapabilityProbeContext(input)).toEqual({
            cacheKeySuffixParts: ['happier.agent.claude/claude-subscription:group:team'],
            capabilityParams: { connectedServices: input.connectedServices },
            modelSuccessCacheMaxAgeMs: 5 * 60_000,
        });
        expect(resolveNewSessionModelCapabilityProbeContext({
            ...input,
            connectedServices: ConnectedServiceBindingsV1Schema.parse({
                v: 1,
                bindingsByServiceId: { 'happier.agent.claude/claude-subscription': { source: 'native' } },
            }),
        })).toBeNull();
    });
});
