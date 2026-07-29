import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '@happier-dev/agents';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    buildConnectedServicesBindingsPayload,
    type ConnectedServicesAccountGroupOptionsByServiceId,
    type ConnectedServicesProfileOptionsByServiceId,
} from './connectedServicesNewSessionBindings';

const profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId = {
    anthropic: [
        { profileId: 'primary', status: 'connected', providerEmail: 'primary@example.com' },
        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
    ],
};

const groupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId = {
    anthropic: [
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

        expect(result?.bindingsByServiceId.anthropic).toEqual({
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

        expect(result?.bindingsByServiceId.anthropic).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'primary',
        });
    });

    it('keeps retryable refresh-failure profiles selectable for spawn bindings', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: {
                anthropic: [
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

        expect(result?.bindingsByServiceId.anthropic).toEqual({
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
            v: 1,
            bindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'group', groupId: 'team' },
            },
        });
    });

    it('preserves explicit group intent when the selected group cannot currently resolve an active connected profile', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: {
                anthropic: [
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
            v: 1,
            bindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'group', groupId: 'team' },
            },
        });
    });

    it('preserves explicit group intent when the selected group is not ready', () => {
        const result = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds: ['anthropic'],
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: {
                anthropic: [
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
            v: 1,
            bindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'group', groupId: 'team' },
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
            agentCore: AGENTS_CORE.opencode,
            supportedConnectedServiceIds: AGENTS_CORE.opencode.connectedServices?.supportedServiceIds ?? [],
            labelsByKey: {},
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
            }),
        ]);
    });
});
