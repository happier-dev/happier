import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '@happier-dev/agents';
import { connectedServiceProfileKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    buildConnectedServicesBindingsPayload,
    type ConnectedServicesAccountGroupOptionsByServiceId,
    type ConnectedServicesProfileOptionsByServiceId,
} from './connectedServicesNewSessionBindings';

const ANTHROPIC_SERVICE_KEY = 'happier.agent.claude/anthropic';

const profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId = {
    [ANTHROPIC_SERVICE_KEY]: [
        { profileId: 'primary', status: 'connected', providerEmail: 'primary@example.com' },
        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
    ],
};

const groupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId = {
    [ANTHROPIC_SERVICE_KEY]: [
        {
            groupId: 'team',
            label: 'Team',
            activeProfileId: 'primary',
            enabledMemberCount: 2,
            autoSwitch: true,
            status: 'ready',
        },
    ],
};

describe('connectedServicesNewSessionBindings', () => {
    it('discloses only declared launch purposes after resolving the actual connected selection', async () => {
        const { projectSessionCredentialSignInPurposes } = await import('./connectedServicesNewSessionBindings');
        const declarations = [
            { purpose: 'model_upstream_api_key', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' } },
            { purpose: 'model_upstream', service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } },
        ];
        const bindings = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: declarations.map(declaration => buildQualifiedPluginContributionKey(declaration.service)),
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServicesBindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'primary' },
                'happier.agent.claude/claude-subscription': { source: 'native' },
                'happier.connect.linear/linear': { source: 'connected', selection: 'profile', profileId: 'private-linear-account' },
            },
            defaultProfileByServiceId: {},
        });
        const labels = projectSessionCredentialSignInPurposes({ declarations, bindings,
            resolveServiceTitle: service => service.localId === 'anthropic' ? 'Anthropic API key'
                : service.localId === 'claude-subscription' ? 'Claude subscription' : 'Linear',
            formatNativeTitle: title => `${title} (native sign-in)`,
        });
        expect(labels).toEqual(['Anthropic API key', 'Claude subscription (native sign-in)']);
        expect(JSON.stringify(labels)).not.toContain('private-linear-account');
        expect(projectSessionCredentialSignInPurposes({ declarations: [], bindings,
            resolveServiceTitle: () => 'Linear', formatNativeTitle: title => title })).toEqual([]);
        expect(projectSessionCredentialSignInPurposes({ declarations, bindings: null,
            resolveServiceTitle: service => service.localId === 'anthropic' ? 'Anthropic API key' : 'Claude subscription',
            formatNativeTitle: title => `${title} (native sign-in)`,
        })).toEqual(['Anthropic API key (native sign-in)', 'Claude subscription (native sign-in)']);
    });

    it('keeps explicit native intent distinct from omission at launch', () => {
        const input = {
            supportedConnectedServiceIds: [ANTHROPIC_SERVICE_KEY],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            defaultProfileByServiceId: {},
        };
        expect(buildConnectedServicesBindingsPayload({
            ...input,
            connectedServicesBindingsByServiceId: {},
        })).toBeNull();
        expect(buildConnectedServicesBindingsPayload({
            ...input,
            connectedServicesBindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: { source: 'native' },
            },
        })).toEqual({
            v: 2,
            bindingsByServiceId: { [ANTHROPIC_SERVICE_KEY]: { source: 'native' } },
        });
    });

    it('can serialize an all-native V2 payload for an existing-session disconnect', () => {
        expect(buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServicesBindingsByServiceId: {
                anthropic: { source: 'native' },
            },
            defaultProfileByServiceId: {},
            emitWhenAllNative: true,
        })).toEqual({
            v: 2,
            bindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: { source: 'native' },
            },
        });
    });

    it('serializes an exact Team resource binding as V2 without source metadata', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServicesBindingsByServiceId: {
                anthropic: {
                    source: 'team_resource',
                    resourceId: 'resource-1',
                    deliveryMode: 'brokered',
                },
            },
            defaultProfileByServiceId: {},
        });

        expect(result).toEqual({
            v: 2,
            bindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: {
                    source: 'team_resource',
                    resourceId: 'resource-1',
                    deliveryMode: 'brokered',
                },
            },
        });
        expect(JSON.stringify(result)).not.toContain('accountId');
        expect(JSON.stringify(result)).not.toContain('custodian');
    });

    it('preserves valid authored qualified bindings that are no longer declared', () => {
        const linearServiceKey = 'happier.connect.linear/linear';
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServicesBindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'backup' },
                [linearServiceKey]: { source: 'connected', selection: 'profile', profileId: 'linear-work' },
                linear: { source: 'native' },
                'not/a/qualified/key': { source: 'native' },
            },
            defaultProfileByServiceId: {},
            emitWhenAllNative: true,
        });

        expect(result).toEqual({
            v: 2,
            bindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'backup' },
                [linearServiceKey]: { source: 'connected', selection: 'profile', profileId: 'linear-work' },
            },
        });
    });

    it('emits a group binding without persisting a stale fallback profile', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: groupOptionsByServiceId,
            connectedServicesBindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'team',
                },
            },
            defaultProfileByServiceId: {},
            accountGroupsFeatureEnabled: true,
        });

        expect(result?.bindingsByServiceId[ANTHROPIC_SERVICE_KEY]).toEqual({
            source: 'connected',
            selection: 'group',
            groupId: 'team',
        });
    });

    it('does not implicitly convert a selected profile into a group binding', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: groupOptionsByServiceId,
            connectedServicesBindingsByServiceId: {
                anthropic: { source: 'connected', profileId: 'primary' },
            },
            defaultProfileByServiceId: {},
            accountGroupsFeatureEnabled: true,
        });

        expect(result?.bindingsByServiceId[ANTHROPIC_SERVICE_KEY]).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'primary',
        });
    });

    it('keeps retryable refresh-failure profiles selectable for spawn bindings', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: [
                    { profileId: 'retryable', status: 'refresh_failed_retryable', providerEmail: 'retryable@example.com' },
                ],
            },
            connectedServiceAccountGroupOptionsByServiceId: {},
            connectedServicesBindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'profile', profileId: 'retryable' },
            },
            defaultProfileByServiceId: {},
            accountGroupsFeatureEnabled: true,
        });

        expect(result?.bindingsByServiceId[ANTHROPIC_SERVICE_KEY]).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'retryable',
        });
    });

    it('preserves explicit group intent when account groups are unavailable for spawn', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: groupOptionsByServiceId,
            connectedServicesBindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'team',
                },
            },
            defaultProfileByServiceId: {},
            accountGroupsFeatureEnabled: false,
        });

        expect(result).toEqual({
            v: 2,
            bindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'team' },
            },
        });
    });

    it('preserves explicit group intent when the selected group cannot currently resolve an active connected profile', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: [
                    {
                        groupId: 'team',
                        label: 'Team',
                        activeProfileId: 'missing',
                        enabledMemberCount: 2,
                        autoSwitch: true,
                        status: 'ready',
                    },
                ],
            },
            connectedServicesBindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'team',
                },
            },
            defaultProfileByServiceId: {},
            accountGroupsFeatureEnabled: true,
        });

        expect(result).toEqual({
            v: 2,
            bindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'team' },
            },
        });
    });

    it('preserves explicit group intent when the selected group is not ready', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: [
                    {
                        groupId: 'team',
                        label: 'Team',
                        activeProfileId: 'primary',
                        enabledMemberCount: 2,
                        autoSwitch: true,
                        status: 'exhausted',
                    },
                ],
            },
            connectedServicesBindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'team',
                },
            },
            defaultProfileByServiceId: {},
            accountGroupsFeatureEnabled: true,
        });

        expect(result).toEqual({
            v: 2,
            bindingsByServiceId: {
                [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'team' },
            },
        });
    });

    it('builds group options only from supported services when the feature is enabled', () => {
        const result = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: true,
            supportedConnectedServiceIds: ['anthropic'],
            accountProfileConnectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    groups: [
                        {
                            v: 1,
                            serviceId: 'anthropic',
                            groupId: 'team',
                            displayName: 'Team',
                            activeProfileId: 'primary',
                            members: [{ profileId: 'primary' }, { profileId: 'backup' }],
                        },
                    ],
                },
                {
                    serviceId: 'openai-codex',
                    groups: [{ groupId: 'codex', activeProfileId: 'main', members: [{ profileId: 'main' }] }],
                },
            ],
        });

        expect(result).toEqual({
            anthropic: [
                {
                    groupId: 'team',
                    label: 'Team',
                    activeProfileId: 'primary',
                    memberProfileIds: ['primary', 'backup'],
                    enabledMemberCount: 2,
                    autoSwitch: false,
                    status: 'ready',
                },
            ],
        });
    });

    it('prefers state.status when projecting exhausted account groups', () => {
        const result = buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled: true,
            supportedConnectedServiceIds: ['anthropic'],
            accountProfileConnectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    groups: [
                        {
                            v: 1,
                            serviceId: 'anthropic',
                            groupId: 'team',
                            displayName: 'Team',
                            activeProfileId: 'primary',
                            status: 'ready',
                            state: { status: 'exhausted' },
                            members: [{ profileId: 'primary' }, { profileId: 'backup' }],
                        },
                    ],
                },
            ],
        });

        expect(result).toEqual({
            anthropic: [
                {
                    groupId: 'team',
                    label: 'Team',
                    activeProfileId: 'primary',
                    memberProfileIds: ['primary', 'backup'],
                    enabledMemberCount: 2,
                    autoSwitch: false,
                    status: 'exhausted',
                },
            ],
        });
    });

    it('keeps OpenCode Claude subscription OAuth profiles connected when the manifest supports OAuth', () => {
        const result = buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2: [{
                serviceId: 'claude-subscription',
                profiles: [
                    {
                        profileId: 'claude-pro-token',
                        status: 'connected',
                        kind: 'token',
                        providerEmail: 'token@example.com',
                    },
                    {
                        profileId: 'claude-pro-oauth',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: 'oauth@example.com',
                    },
                ],
            }],
            supportedConnectedServiceIds: AGENTS_CORE.opencode.connectedServices?.supportedServiceIds ?? [],
            labelsByKey: { [connectedServiceProfileKey({ serviceId: 'claude-subscription',
                profileId: 'claude-pro-oauth' })]: 'Personal subscription' },
        });

        expect(result['claude-subscription']).toEqual([
            expect.objectContaining({
                profileId: 'claude-pro-token',
                status: 'connected',
                kind: 'token',
            }),
            expect.objectContaining({
                profileId: 'claude-pro-oauth',
                status: 'connected',
                kind: 'oauth',
                label: 'Personal subscription',
            }),
        ]);
    });
});

describe('composeConnectedServiceTeamCredentialBindingIntents', () => {
    it('turns the Agent page Team purpose default into the New Session Team slot binding at the current revision', async () => {
        const {
            projectAgentConnectedAccountPurposeDefaultsToSessionBindings,
            resolveAgentConnectedAccountPurposeDefaults,
            writeAgentConnectedAccountPurposeDefault,
        } = await import('@happier-dev/protocol');
        const { composeConnectedServiceTeamCredentialBindingIntents } = await import('./connectedServicesNewSessionBindings');
        const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' } as const;
        const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' } as const;
        const declarations = [{ purpose: 'primary', service }] as const;
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-acme',
            deliveryMode: 'direct' as const,
            disclosedMember: { service, accountId: 'source-member' },
        };
        // The Agent page writes through the one default-authentication owner.
        const settings = writeAgentConnectedAccountPurposeDefault({
            settings: {},
            agentId: 'claude',
            consumer,
            declarations,
            purpose: 'primary',
            target: null,
            teamResource: { teamId: 'team-acme', selection },
        });
        const bindings = projectAgentConnectedAccountPurposeDefaultsToSessionBindings(
            resolveAgentConnectedAccountPurposeDefaults({ settings, purposeBindings: settings.connectedAccountPurposeBindingsV1,
                agentId: 'claude', consumer, declarations }),
        );
        expect(bindings).not.toBeNull();
        const resource = {
            id: 'resource-acme', teamId: 'team-acme', displayName: 'Acme', resourceRevision: 5,
            readiness: { kind: 'available' as const }, recoveryAction: null,
            mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current' as const,
            sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
            connectedServiceSelections: [selection],
            sourcePresentation: { kind: 'connected_service' as const, service },
        };

        expect(composeConnectedServiceTeamCredentialBindingIntents({
            consumer, declarations, bindings: bindings!, resources: [resource],
        })).toEqual([{
            v: 1,
            slot: { kind: 'connected_service_purpose', purpose: { consumer, purpose: 'primary' } },
            resourceId: 'resource-acme',
            expectedResourceRevision: 5,
            deliveryMode: 'direct',
        }]);
        // A resource this Home no longer offers composes no binding.
        expect(composeConnectedServiceTeamCredentialBindingIntents({
            consumer, declarations, bindings: bindings!, resources: [],
        })).toEqual([]);
    });
});
