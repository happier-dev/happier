import { describe, expect, it } from 'vitest';

import type {
    ConnectedServiceRegistryEntry,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';

import { resolveVoiceConnectRecoveryTarget } from './resolveVoiceConnectRecoveryTarget';

const connectedServiceEntry: ConnectedServiceRegistryEntry = {
    serviceId: 'openai-codex',
    service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
    },
    connectCommand: 'happier connect acme.connected-accounts/codex-account',
    supportsOauth: true,
    executable: true,
};

const provider = {
    sourcePluginId: 'acme.voice-agent',
    connectedServicesBinding: {
        id: 'agentAccounts',
        title: 'Agent account',
        agent: 'worker',
        serviceIds: ['openai-codex'] as const,
    },
} as const;

const agentRuntime = {
    pluginId: 'acme.voice-agent',
    localId: 'worker',
};

const runtimeTarget = {
    serverId: 'server-selected',
    machineId: 'machine-selected',
};

const codexProvider = {
    sourcePluginId: 'happier.agent.codex',
    connectedServicesBinding: {
        id: 'agentAccounts',
        title: 'Agent account',
        agent: 'codex',
        serviceIds: ['openai-codex'] as const,
    },
} as const;

const codexAgentRuntime = {
    pluginId: 'happier.agent.codex',
    localId: 'codex',
};

describe('resolveVoiceConnectRecoveryTarget', () => {
    it('projects a provider-neutral selected profile through the qualified account owner', () => {
        expect(resolveVoiceConnectRecoveryTarget({
            agentRuntime,
            bindingScope: 'global',
            runtimeTarget,
            provider,
            providerConfig: {
                agentAccounts: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'account-work',
                        },
                    },
                },
            },
            sessionMetadata: null,
            connectedServiceEntries: [connectedServiceEntry],
        })).toEqual({
            kind: 'exact',
            route: {
                pathname: '/(app)/settings/connected-services/account',
                params: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    accountId: 'account-work',
                    serverId: 'server-selected',
                    machineId: 'machine-selected',
                },
            },
        });
    });

    it('projects a provider-neutral selected group through the qualified account owner', () => {
        expect(resolveVoiceConnectRecoveryTarget({
            agentRuntime,
            bindingScope: 'global',
            runtimeTarget,
            provider,
            providerConfig: {
                agentAccounts: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'team-work',
                        },
                    },
                },
            },
            sessionMetadata: null,
            connectedServiceEntries: [connectedServiceEntry],
        })).toEqual({
            kind: 'exact',
            route: {
                pathname: '/(app)/settings/connected-services/account',
                params: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    groupId: 'team-work',
                    serverId: 'server-selected',
                    machineId: 'machine-selected',
                },
            },
        });
    });

    it.each([
        ['provider config is missing', null],
        ['binding field is missing', {}],
        ['binding is null', { agentAccounts: null }],
        ['binding is malformed', { agentAccounts: { v: 1, bindingsByServiceId: [] } }],
    ])('routes to the canonical Voice binding setup when %s', (_title, providerConfig) => {
        expect(resolveVoiceConnectRecoveryTarget({
            agentRuntime,
            bindingScope: 'global',
            runtimeTarget,
            provider,
            providerConfig,
            sessionMetadata: null,
            connectedServiceEntries: [connectedServiceEntry],
        })).toEqual({ kind: 'provider_settings' });
    });

    it('uses the direct session runtime descriptor instead of the conflicting global account selection', () => {
        expect(resolveVoiceConnectRecoveryTarget({
            agentRuntime: codexAgentRuntime,
            runtimeTarget,
            provider: codexProvider,
            bindingScope: 'session',
            sessionMetadata: {
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        providerSessionId: 'thread-session',
                        home: 'connectedService',
                        connectedServiceId: 'openai-codex',
                        connectedServiceGroupId: 'team-session',
                        connectedServiceProfileId: 'account-session',
                    },
                },
            },
            providerConfig: {
                agentAccounts: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'account-global',
                        },
                    },
                },
            },
            connectedServiceEntries: [connectedServiceEntry],
        })).toEqual({
            kind: 'exact',
            route: {
                pathname: '/(app)/settings/connected-services/account',
                params: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    groupId: 'team-session',
                    serverId: 'server-selected',
                    machineId: 'machine-selected',
                },
            },
        });
    });

    it('fails direct-session recovery closed when the exact session binding is unavailable', () => {
        expect(resolveVoiceConnectRecoveryTarget({
            agentRuntime: codexAgentRuntime,
            runtimeTarget,
            provider: codexProvider,
            bindingScope: 'session',
            sessionMetadata: {
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        providerSessionId: 'thread-session',
                    },
                },
            },
            providerConfig: {
                agentAccounts: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'account-global',
                        },
                    },
                },
            },
            connectedServiceEntries: [connectedServiceEntry],
        })).toEqual({ kind: 'unavailable' });
    });

    it.each([
        {
            title: 'selected service is no longer executable',
            agent: agentRuntime,
            runtime: runtimeTarget,
            entries: [{ ...connectedServiceEntry, executable: false }],
        },
        {
            title: 'selected runtime target is unavailable',
            agent: agentRuntime,
            runtime: null,
            entries: [connectedServiceEntry],
        },
        {
            title: 'binding Agent no longer matches the executable Agent',
            agent: { pluginId: 'acme.voice-agent', localId: 'other-worker' },
            runtime: runtimeTarget,
            entries: [connectedServiceEntry],
        },
    ])('fails closed when $title', ({ agent, runtime, entries }) => {
        expect(resolveVoiceConnectRecoveryTarget({
            agentRuntime: agent,
            bindingScope: 'global',
            runtimeTarget: runtime,
            provider,
            providerConfig: {
                agentAccounts: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            profileId: 'account-work',
                        },
                    },
                },
            },
            sessionMetadata: null,
            connectedServiceEntries: entries,
        })).toEqual({ kind: 'unavailable' });
    });
});
