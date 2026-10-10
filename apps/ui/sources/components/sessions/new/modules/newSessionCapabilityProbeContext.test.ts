import { describe, expect, it, vi } from 'vitest';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';

describe('resolveNewSessionCapabilityProbeContext (stability)', () => {
    it('includes the selected launch profile in every session-control probe context', async () => {
        vi.resetModules();
        vi.doMock('@/agents/registry/registryUiBehavior', () => ({
            resolveConfiguredAgentRuntimeKindFromUiBehavior: vi.fn(() => null),
        }));
        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        const backendTarget = {
            kind: 'agent' as const,
            identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex,
        };

        expect(resolveNewSessionCapabilityProbeContext({
            backendTarget,
            settings: {} as any,
            selectedProfileId: 'work',
        })).toMatchObject({
            cacheKeySuffixParts: ['profile:work'],
            capabilityParams: { profileId: 'work' },
        });
    });

    it('reads the runtime kind from the canonical settings it is given instead of rebuilding them', async () => {
        // The open engine picker resolves this context on every render. Re-parsing
        // the whole Account settings there measured ~10% of page CPU and stalled
        // the web composer for seconds per store update.
        vi.resetModules();
        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn((_input: Readonly<{ settings: unknown }>) => 'appServer');
        vi.doMock('@/agents/registry/registryUiBehavior', () => ({ resolveConfiguredAgentRuntimeKindFromUiBehavior }));
        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        const settings = {} as any;

        resolveNewSessionCapabilityProbeContext({
            backendTarget: { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
            settings,
        });

        expect(resolveConfiguredAgentRuntimeKindFromUiBehavior).toHaveBeenCalledTimes(1);
        expect(resolveConfiguredAgentRuntimeKindFromUiBehavior.mock.calls[0]?.[0].settings).toBe(settings);
    });

    it('returns stable references when runtimeKind is unchanged', async () => {
        vi.resetModules();

        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => 'appServer');
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');

        const settings = {} as any;
        const backendTarget = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex };

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
        const backendTarget = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex };

        const first = resolveNewSessionCapabilityProbeContext({ backendTarget, settings });
        runtimeKind = 'system';
        const second = resolveNewSessionCapabilityProbeContext({ backendTarget, settings });

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(first).not.toBe(second);
        expect(first?.cacheKeySuffixParts).not.toBe(second?.cacheKeySuffixParts);
        expect(first?.capabilityParams).not.toBe(second?.capabilityParams);
    });

    it('probes an installed Agent backend through its operational identity', async () => {
        vi.resetModules();

        const resolveConfiguredAgentRuntimeKindFromUiBehavior = vi.fn(() => 'appServer');
        vi.doMock('@/agents/registry/registryUiBehavior', () => {
            return { resolveConfiguredAgentRuntimeKindFromUiBehavior };
        });

        const { resolveNewSessionCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');

        const settings = {} as any;
        const backendTarget = { kind: 'builtInAgent', agentId: 'acme.review.backend' } as any;

        expect(resolveNewSessionCapabilityProbeContext({
            backendTarget,
            settings,
            runtimeCarrierAgentId: 'acme.review.backend',
            machineId: 'machine-a',
        })).toEqual({
            cacheKeySuffixParts: ['appServer'],
            capabilityParams: {},
        });
        expect(resolveConfiguredAgentRuntimeKindFromUiBehavior).toHaveBeenCalledWith({
            agentId: 'acme.review.backend',
            settings: expect.any(Object),
            machineId: 'machine-a',
        });
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
        const backendTarget = { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude };
        // Canonical bindings are keyed by the qualified service key; the bundled
        // `claude-subscription` observation must translate through the legacy
        // ingress before lookup and cache identity.
        const CLAUDE_SUBSCRIPTION_SERVICE_KEY = 'happier.agent.claude/claude-subscription';
        const firstConnectedServices = ConnectedServiceBindingsV2Schema.parse({
            v: 2,
            bindingsByServiceId: {
                [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                },
            },
        });
        const secondConnectedServices = ConnectedServiceBindingsV2Schema.parse({
            v: 2,
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

        expect(shared?.capabilityParams).toEqual({ connectedServices: firstConnectedServices });
        expect(first?.capabilityParams).toEqual({
            connectedServices: firstConnectedServices,
        });
        expect(first?.cacheKeySuffixParts?.join(' ')).toContain(CLAUDE_SUBSCRIPTION_SERVICE_KEY);
        expect(first?.cacheKeySuffixParts?.join(' ')).toContain('work');
        expect(second?.cacheKeySuffixParts?.join(' ')).toContain('personal');
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
            backendTarget: { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude },
            settings: {} as any,
            // The released bundled model-config author fact carries the scalar
            // id; the canonical binding payload carries the qualified key.
            connectedServices: ConnectedServiceBindingsV2Schema.parse({
                v: 2,
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
        expect(context).toMatchObject({
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
            backendTarget: { kind: 'agent' as const, identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude },
            settings: {} as any,
            connectedServices: ConnectedServiceBindingsV2Schema.parse({
                v: 2,
                bindingsByServiceId: {
                    'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'group', groupId: 'team' },
                },
            }),
        };

        const { resolveNewSessionModelCapabilityProbeContext } = await import('./newSessionCapabilityProbeContext');
        expect(resolveNewSessionCapabilityProbeContext(input)?.capabilityParams).toEqual({ connectedServices: input.connectedServices });
        expect(resolveNewSessionModelCapabilityProbeContext(input)).toMatchObject({
            capabilityParams: { connectedServices: input.connectedServices },
            modelSuccessCacheMaxAgeMs: 5 * 60_000,
        });
        expect(resolveNewSessionModelCapabilityProbeContext({
            ...input,
            connectedServices: ConnectedServiceBindingsV2Schema.parse({
                v: 2,
                bindingsByServiceId: { 'happier.agent.claude/claude-subscription': { source: 'native' } },
            }),
        })).toBeNull();
    });
});
