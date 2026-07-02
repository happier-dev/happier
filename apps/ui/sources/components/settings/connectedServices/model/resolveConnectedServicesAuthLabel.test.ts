import { describe, expect, it } from 'vitest';

import { resolveConnectedServicesAuthLabel } from './resolveConnectedServicesAuthLabel';

describe('resolveConnectedServicesAuthLabel', () => {
    it('uses the native label when every supported service is using local auth', () => {
        expect(resolveConnectedServicesAuthLabel({
            supportedServiceIds: ['anthropic'],
            bindingsByServiceId: { anthropic: { source: 'native' } },
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'connected', label: 'Work' }],
            },
            resolveServiceTitle: (serviceId) => `service:${serviceId}`,
            nativeLabel: 'Native',
            formatConnectedCountLabel: (count) => `${count} connected`,
        })).toEqual({
            label: 'Native',
            connectedCount: 0,
            serviceStatesById: {
                anthropic: {
                    effectiveSource: 'native',
                    requestedSource: 'native',
                },
            },
            warningCodes: [],
        });
    });

    it('uses a compact service and profile label for one connected profile', () => {
        expect(resolveConnectedServicesAuthLabel({
            supportedServiceIds: ['anthropic'],
            bindingsByServiceId: { anthropic: { source: 'connected', selection: 'profile', profileId: 'work' } },
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'connected', label: 'Work', providerEmail: 'work@example.com' }],
            },
            resolveServiceTitle: (serviceId) => serviceId === 'anthropic' ? 'Anthropic' : serviceId,
            nativeLabel: 'Native',
            formatConnectedCountLabel: (count) => `${count} connected`,
        })).toEqual({
            label: 'Anthropic: Work',
            connectedCount: 1,
            serviceStatesById: {
                anthropic: {
                    effectiveSource: 'connected',
                    effectiveSelection: 'profile',
                    profileId: 'work',
                    requestedSource: 'connected',
                    requestedSelection: 'profile',
                },
            },
            warningCodes: [],
        });
    });

    it('uses an aggregate label when multiple services are connected', () => {
        expect(resolveConnectedServicesAuthLabel({
            supportedServiceIds: ['anthropic', 'openai'],
            bindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                openai: { source: 'connected', selection: 'profile', profileId: 'personal' },
            },
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'connected', label: 'Work' }],
                openai: [{ profileId: 'personal', status: 'connected', label: 'Personal' }],
            },
            resolveServiceTitle: (serviceId) => serviceId,
            nativeLabel: 'Native',
            formatConnectedCountLabel: (count) => `${count} connected`,
        })).toEqual({
            label: '2 connected',
            connectedCount: 2,
            serviceStatesById: {
                anthropic: {
                    effectiveSource: 'connected',
                    effectiveSelection: 'profile',
                    profileId: 'work',
                    requestedSource: 'connected',
                    requestedSelection: 'profile',
                },
                openai: {
                    effectiveSource: 'connected',
                    effectiveSelection: 'profile',
                    profileId: 'personal',
                    requestedSource: 'connected',
                    requestedSelection: 'profile',
                },
            },
            warningCodes: [],
        });
    });

    it('reports a stale connected profile as an effective native fallback', () => {
        const model = resolveConnectedServicesAuthLabel({
            supportedServiceIds: ['anthropic'],
            bindingsByServiceId: { anthropic: { source: 'connected', selection: 'profile', profileId: 'missing' } },
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'connected', label: 'Work' }],
            },
            defaultProfileIdByServiceId: { anthropic: 'work' },
            resolveServiceTitle: (serviceId) => serviceId,
            nativeLabel: 'Native',
            formatConnectedCountLabel: (count) => `${count} connected`,
        });

        expect(model.connectedCount).toBe(0);
        expect(model.serviceStatesById.anthropic).toMatchObject({
            effectiveSource: 'native',
            requestedSource: 'connected',
            requestedSelection: 'profile',
            warningCode: 'connected_profile_unavailable',
        });
        expect(model.warningCodes).toEqual(['connected_profile_unavailable']);
    });

    it('preserves a group binding when the active profile changes', () => {
        const model = resolveConnectedServicesAuthLabel({
            supportedServiceIds: ['openai-codex'],
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'primary',
                    profileId: 'stale-profile',
                },
            },
            profileOptionsByServiceId: {
                'openai-codex': [
                    { profileId: 'fresh-profile', status: 'connected', label: 'Fresh' },
                ],
            },
            accountGroupOptionsByServiceId: {
                'openai-codex': [{
                    groupId: 'primary',
                    label: 'Primary pool',
                    activeProfileId: 'fresh-profile',
                    enabledMemberCount: 2,
                    autoSwitch: true,
                    status: 'ready',
                }],
            },
            resolveServiceTitle: () => 'Codex',
            nativeLabel: 'Native',
            formatConnectedCountLabel: (count) => `${count} connected`,
        });

        expect(model.connectedCount).toBe(1);
        expect(model.serviceStatesById['openai-codex']).toMatchObject({
            effectiveSource: 'connected',
            effectiveSelection: 'group',
            groupId: 'primary',
            profileId: 'fresh-profile',
            requestedSource: 'connected',
            requestedSelection: 'group',
        });
        expect(model.warningCodes).toEqual([]);
    });

    it('reports a missing group as an effective native fallback', () => {
        const model = resolveConnectedServicesAuthLabel({
            supportedServiceIds: ['openai-codex'],
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'missing-group',
                    profileId: 'work',
                },
            },
            profileOptionsByServiceId: {
                'openai-codex': [{ profileId: 'work', status: 'connected', label: 'Work' }],
            },
            accountGroupsEnabled: true,
            resolveServiceTitle: () => 'Codex',
            nativeLabel: 'Native',
            formatConnectedCountLabel: (count) => `${count} connected`,
        });

        expect(model.connectedCount).toBe(0);
        expect(model.serviceStatesById['openai-codex']).toMatchObject({
            effectiveSource: 'native',
            requestedSource: 'connected',
            requestedSelection: 'group',
            warningCode: 'connected_group_unavailable',
        });
        expect(model.warningCodes).toEqual(['connected_group_unavailable']);
    });

    it('reports connected auth for an unsupported service as an effective native fallback', () => {
        const model = resolveConnectedServicesAuthLabel({
            supportedServiceIds: ['anthropic'],
            bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
            },
            profileOptionsByServiceId: {},
            resolveServiceTitle: (serviceId) => serviceId,
            nativeLabel: 'Native',
            formatConnectedCountLabel: (count) => `${count} connected`,
        });

        expect(model.connectedCount).toBe(0);
        expect(model.serviceStatesById['openai-codex']).toMatchObject({
            effectiveSource: 'native',
            requestedSource: 'connected',
            requestedSelection: 'profile',
            warningCode: 'connected_service_unsupported',
        });
        expect(model.warningCodes).toEqual(['connected_service_unsupported']);
    });
});
