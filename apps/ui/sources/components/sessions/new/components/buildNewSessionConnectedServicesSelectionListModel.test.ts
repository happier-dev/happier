import { describe, expect, it, vi } from 'vitest';

import {
    buildNewSessionConnectedServicesSelectionListModel,
    createConnectedServiceGroupOptionId,
    createConnectedServiceOptionId,
    createNativeServiceOptionId,
    createReauthServiceOptionId,
    createTeamResourceServiceOptionId,
    type NewSessionConnectedServicesSelectionListModel,
} from './buildNewSessionConnectedServicesSelectionListModel';

function firstStaticSection(model: NewSessionConnectedServicesSelectionListModel) {
    const section = model.rootStep.sections[0];
    if (!section || section.kind !== 'static') {
        throw new Error('Expected a static connected service section');
    }
    return section;
}

function buildModel(overrides: Partial<Parameters<typeof buildNewSessionConnectedServicesSelectionListModel>[0]> = {}) {
    return buildNewSessionConnectedServicesSelectionListModel({
        supportedServiceIds: ['anthropic'],
        profileOptionsByServiceId: {
            anthropic: [{ profileId: 'work', status: 'connected', providerEmail: 'work@example.com' }],
        },
        groupOptionsByServiceId: {},
        bindingsByServiceId: { anthropic: { source: 'native' } },
        quotaBadgesByKey: {},
        setBindingForService: vi.fn(),
        onOpenSettings: vi.fn(),
        translate: ((key: string, params?: { profileId?: string }) =>
            key === 'connectedServices.detail.groups.activeMember' && params?.profileId
                ? `Active ${params.profileId}`
                : key) as Parameters<typeof buildNewSessionConnectedServicesSelectionListModel>[0]['translate'],
        resolveServiceTitle: (serviceId) => `service:${serviceId}`,
        renderSelectionIcon: ({ selected }) => selected ? 'selected-icon' : 'unselected-icon',
        renderSettingsIcon: () => 'settings-icon',
        renderQuotaBadges: (badges) => `badges:${badges.map((badge) => badge.text).join(',')}`,
        renderNeedsReauthPill: () => 'needs-reauth',
        ...overrides,
    });
}

describe('buildNewSessionConnectedServicesSelectionListModel', () => {
    it('does not check Native for unread inherited bindings while retaining explicit Native recovery', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({ bindingsByServiceId: {}, bindingsKnown: false, setBindingForService });
        expect(model.selectedOptionId).toBeNull();
        const native = firstStaticSection(model).options.find(option => option.id === createNativeServiceOptionId('anthropic'));
        expect(native?.icon).toBe('unselected-icon');
        native?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'native' });
    });
    it('keeps routing identity out of an account row after device identity presentation', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: { anthropic: [{
                profileId: 'opaque-route-42', status: 'connected', label: 'Work', providerEmail: 'wo•••@e•••.com',
            }, { profileId: 'unnamed-route-43', status: 'connected' }] },
            setBindingForService,
        });
        const row = firstStaticSection(model).options.find((option) => option.id === createConnectedServiceOptionId('anthropic', 'opaque-route-42'));
        expect(row).toMatchObject({ label: 'Work', subtitle: 'wo•••@e•••.com' });
        expect(row?.accessibilityLabel).not.toContain('opaque-route-42');
        expect(firstStaticSection(model).options.find((option) => option.id === createConnectedServiceOptionId('anthropic', 'unnamed-route-43')))
            .toMatchObject({ label: 'service:anthropic' });
        row?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'connected', selection: 'profile', profileId: 'opaque-route-42' });
    });

    it('offers each brokered Connected Account and Pool resource exactly once', () => {
        const setBindingForService = vi.fn();
        const service = { pluginId: 'service.plugin', localId: 'mail' } as const;
        const resources = [
            { id: 'account-resource', displayName: 'Brokered account' },
            { id: 'pool-resource', displayName: 'Brokered pool' },
        ].map(({ id, displayName }) => ({
            id,
            teamId: 'team-1',
            displayName,
            resourceRevision: 7,
            readiness: { kind: 'available' as const },
            recoveryAction: null,
            deliveryMode: 'brokered' as const,
            mayBroker: true,
            mayReceiveDirect: false,
            directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: { kind: 'connected_service' as const, service },
            connectedServiceSelections: [{
                source: 'team_resource' as const,
                resourceId: id,
                deliveryMode: 'brokered' as const,
            }],
        }));
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: {},
            includeNativeAuthOption: false,
            setBindingForService,
            teamCredentialResources: resources,
            teamNameById: { 'team-1': 'Acme' },
        });

        const options = firstStaticSection(model).options;
        expect(options.filter((option) => option.label === 'Brokered account')).toHaveLength(1);
        expect(options.filter((option) => option.label === 'Brokered pool')).toHaveLength(1);
        options.find((option) => option.label === 'Brokered pool')?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('service.plugin/mail', {
            source: 'team_resource',
            resourceId: 'pool-resource',
            deliveryMode: 'brokered',
        });
    });

    it('writes the exact recipient-safe Team resource witness selected in New Session', () => {
        const setBindingForService = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-1',
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'service.plugin', localId: 'mail' },
                accountId: 'shared-account',
            },
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: {},
            includeNativeAuthOption: false,
            setBindingForService,
            teamCredentialResources: [{
                id: 'resource-1', teamId: 'team-1', displayName: 'Shared mail',
                resourceRevision: 7, readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: false, mayReceiveDirect: true,
                directMaterialState: 'current', sessionUsePolicy: 'personal_allowed',
                providerModels: [],
                sourcePresentation: {
                    kind: 'connected_service',
                    service: selection.disclosedMember.service,
                },
                connectedServiceSelections: [selection],
            }],
            teamNameById: { 'team-1': 'Acme' },
        });

        const option = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(selection)
        ));
        expect(option).toMatchObject({ label: 'Shared mail' });
        option?.onSelect?.();
        expect(setBindingForService).toHaveBeenCalledWith('service.plugin/mail', selection);
    });

    it('keeps an unavailable Team resource keyboard-action and routes its recovery without changing the binding', () => {
        const recover = vi.fn();
        const setBindingForService = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-1',
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'service.plugin', localId: 'mail' },
                accountId: 'shared-account',
            },
        };
        const resource = {
            id: 'resource-1', teamId: 'team-1', displayName: 'Shared mail', resourceRevision: 7,
            readiness: { kind: 'source_unavailable' as const }, recoveryAction: 'source_owner_action' as const,
            deliveryMode: 'direct' as const, mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'stale' as const, sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: { kind: 'connected_service' as const, service: selection.disclosedMember.service },
            connectedServiceSelections: [selection],
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'], profileOptionsByServiceId: {},
            bindingsByServiceId: {}, includeNativeAuthOption: false,
            setBindingForService, teamCredentialResources: [resource],
            onRecoverTeamCredentialResource: recover,
        });

        const option = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(selection)
        ));
        expect(option).toMatchObject({ disabled: false });
        option?.onSelect?.();
        expect(recover).toHaveBeenCalledWith(resource);
        expect(setBindingForService).not.toHaveBeenCalled();
    });

    it('retains a stale catalog resource with recovery instead of silently removing it', () => {
        const recover = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'stale-resource',
            deliveryMode: 'brokered' as const,
        };
        const resource = {
            id: selection.resourceId,
            teamId: 'team-1',
            displayName: 'Shared build account',
            resourceRevision: 8,
            readiness: { kind: 'available' as const },
            recoveryAction: null,
            mayBroker: true,
            mayReceiveDirect: false,
            directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'service.plugin', localId: 'mail' },
            },
            connectedServiceSelections: [selection],
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: {},
            includeNativeAuthOption: false,
            teamCredentialResources: [resource],
            teamCredentialResourceCurrentKeys: new Set(),
            teamNameById: { 'team-1': 'Acme' },
            onRecoverTeamCredentialResource: recover,
        });

        const option = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(selection)
        ));
        expect(option).toMatchObject({
            disabled: false,
            subtitle: 'Acme · teams.unavailable.retry',
        });
        option?.onSelect?.();
        expect(recover).toHaveBeenCalledWith(resource);
    });

    it('keeps a missing retained Team resource selected and unavailable instead of selecting native', () => {
        const binding = {
            source: 'team_resource' as const,
            resourceId: 'revoked-resource',
            deliveryMode: 'brokered' as const,
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: { 'service.plugin/mail': binding },
            includeNativeAuthOption: true,
            teamCredentialResources: [],
        });

        expect(model.selectedOptionId).toBe(createTeamResourceServiceOptionId(binding));
        expect(firstStaticSection(model).options.find((option) => (
            option.id === createTeamResourceServiceOptionId(binding)
        ))).toMatchObject({ disabled: true, subtitle: 'common.unavailable' });
        expect(model.selectedOptionId).not.toBe(createNativeServiceOptionId('service.plugin/mail'));
    });

    it('keeps the Home presentation and recovery action for a retained unavailable Team resource', () => {
        const recover = vi.fn();
        const binding = {
            source: 'team_resource' as const,
            resourceId: 'unavailable-resource',
            deliveryMode: 'brokered' as const,
        };
        const resource = {
            id: binding.resourceId,
            teamId: 'team-1',
            displayName: 'Shared build account',
            resourceRevision: 8,
            readiness: { kind: 'source_unavailable' as const },
            recoveryAction: 'source_owner_action' as const,
            mayBroker: true,
            mayReceiveDirect: false,
            directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [],
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'service.plugin', localId: 'mail' },
            },
            // The resource is retained for presentation/recovery, but the Home
            // correctly publishes no currently selectable binding.
            connectedServiceSelections: [],
        };
        const model = buildModel({
            supportedServiceIds: ['service.plugin/mail'],
            profileOptionsByServiceId: {},
            bindingsByServiceId: { 'service.plugin/mail': binding },
            includeNativeAuthOption: true,
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            onRecoverTeamCredentialResource: recover,
        });

        const option = firstStaticSection(model).options.find((candidate) => (
            candidate.id === createTeamResourceServiceOptionId(binding)
        ));
        expect(option).toMatchObject({
            label: 'Shared build account',
            subtitle: 'Acme · teams.credentials.delivery.brokered · teams.credentials.recovery.ownerHandoff',
            disabled: false,
        });
        option?.onSelect?.();
        expect(recover).toHaveBeenCalledWith(resource);
        expect(model.selectedOptionId).toBe(createTeamResourceServiceOptionId(binding));
        expect(model.selectedOptionId).not.toBe(createNativeServiceOptionId('service.plugin/mail'));
    });

    it('leaves connected-account-only selection empty instead of presenting native auth as persisted', () => {
        const model = buildModel({
            bindingsByServiceId: {},
            includeNativeAuthOption: false,
        });

        expect(model.selectedOptionId).toBeNull();
        expect(firstStaticSection(model).options.some((option) =>
            option.id === createNativeServiceOptionId('anthropic')
        )).toBe(false);
    });

    it('does not visually replace an unavailable exact binding with the general default profile', () => {
        const model = buildModel({
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'unavailable-exact-account',
                },
            },
            defaultProfileIdByServiceId: { anthropic: 'work' },
            includeNativeAuthOption: false,
            allowDefaultProfileFallback: false,
        });

        expect(model.selectedOptionId).toBeNull();
    });

    it('puts connected account rows first and binds the selected account directly', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({ setBindingForService });

        const accountOption = firstStaticSection(model).options[0];
        expect(accountOption).toEqual(expect.objectContaining({
            id: createConnectedServiceOptionId('anthropic', 'work'),
            label: 'work@example.com',
            subtitle: undefined,
        }));

        accountOption?.onSelect?.();

        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
        });
    });

    it('offers connected account groups as a distinct explicit selection', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            setBindingForService,
            groupOptionsByServiceId: {
                anthropic: [
                    {
                        groupId: 'team',
                        label: 'Team',
                        activeProfileId: 'work',
                        enabledMemberCount: 2,
                        autoSwitch: true,
                        status: 'ready',
                    },
                ],
            },
        });

        const groupOption = firstStaticSection(model).options[0];
        expect(groupOption).toEqual(expect.objectContaining({
            id: createConnectedServiceGroupOptionId('anthropic', 'team'),
            label: 'Team',
            subtitle: 'Active work@example.com',
        }));

        groupOption?.onSelect?.();

        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
        });
    });

    it('omits unavailable account groups from selectable session auth options', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            setBindingForService,
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'team',
                },
            },
            groupOptionsByServiceId: {
                anthropic: [
                    {
                        groupId: 'team',
                        label: 'Team',
                        activeProfileId: 'work',
                        enabledMemberCount: 0,
                        autoSwitch: true,
                        status: 'needs_members',
                    },
                    {
                        groupId: 'quota-exhausted',
                        label: 'Quota exhausted',
                        activeProfileId: 'work',
                        enabledMemberCount: 2,
                        autoSwitch: true,
                        status: 'exhausted',
                    },
                ],
            },
        });

        const section = firstStaticSection(model);

        expect(section.options.some((option) =>
            option.id === createConnectedServiceGroupOptionId('anthropic', 'team')
        )).toBe(false);
        expect(section.options.some((option) =>
            option.id === createConnectedServiceGroupOptionId('anthropic', 'quota-exhausted')
        )).toBe(false);
        expect(model.selectedOptionId).toBe(createNativeServiceOptionId('anthropic'));
        expect(setBindingForService).not.toHaveBeenCalled();
    });

    it('selects native auth when a group binding is no longer available', () => {
        const model = buildModel({
            defaultProfileIdByServiceId: { anthropic: 'work' },
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'missing-team',
                },
            },
        });

        const section = firstStaticSection(model);
        const accountOption = section.options.find((option) =>
            option.id === createConnectedServiceOptionId('anthropic', 'work')
        );
        const nativeOption = section.options.find((option) =>
            option.id === createNativeServiceOptionId('anthropic')
        );

        expect(model.selectedOptionId).toBe(createNativeServiceOptionId('anthropic'));
        expect(accountOption?.icon).toBe('unselected-icon');
        expect(nativeOption?.icon).toBe('selected-icon');
    });

    it('keeps local CLI auth as the fallback row for each supported service', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({
            bindingsByServiceId: { anthropic: { source: 'connected', profileId: 'work' } },
            setBindingForService,
        });

        const nativeOption = firstStaticSection(model).options.find((option) => option.id === createNativeServiceOptionId('anthropic'));
        nativeOption?.onSelect?.();

        expect(nativeOption).toEqual(expect.objectContaining({
            label: 'connectedServices.authModal.nativeAuthTitle',
            subtitle: 'connectedServices.authModal.nativeAuthSubtitle',
        }));
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', { source: 'native' });
    });

    it('routes unavailable connected accounts to settings instead of selecting an invalid profile', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' }],
            },
            setBindingForService,
            onOpenSettings,
        });

        const reauthOption = firstStaticSection(model).options.find((option) => option.id === createReauthServiceOptionId('anthropic', 'work'));
        reauthOption?.onSelect?.();

        expect(reauthOption).toEqual(expect.objectContaining({
            rightAccessory: 'needs-reauth',
        }));
        expect(setBindingForService).not.toHaveBeenCalled();
        expect(onOpenSettings).toHaveBeenCalledWith('anthropic');
    });

    it('keeps retryable refresh-failure profiles selectable instead of routing them to reconnect', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'retryable', status: 'refresh_failed_retryable', providerEmail: 'retryable@example.com' }],
            },
            setBindingForService,
            onOpenSettings,
        });

        const accountOption = firstStaticSection(model).options.find((option) =>
            option.id === createConnectedServiceOptionId('anthropic', 'retryable')
        );
        accountOption?.onSelect?.();

        expect(accountOption).toEqual(expect.objectContaining({
            label: 'retryable@example.com',
        }));
        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'profile',
            profileId: 'retryable',
        });
        expect(onOpenSettings).not.toHaveBeenCalled();
    });

    it('routes connected accounts that need reauth through the reconnect callback when available', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const onReconnectProfile = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{ profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' }],
            },
            setBindingForService,
            onOpenSettings,
            onReconnectProfile,
        });

        const reauthOption = firstStaticSection(model).options.find((option) => option.id === createReauthServiceOptionId('anthropic', 'work'));
        reauthOption?.onSelect?.();

        expect(setBindingForService).not.toHaveBeenCalled();
        expect(onOpenSettings).not.toHaveBeenCalled();
        expect(onReconnectProfile).toHaveBeenCalledWith('anthropic', 'work');
    });

    it('shows unsupported connected account kinds as action-required setup guidance rows', () => {
        const setBindingForService = vi.fn();
        const onOpenSettings = vi.fn();
        const model = buildModel({
            profileOptionsByServiceId: {
                anthropic: [{
                    profileId: 'oauth-work',
                    status: 'unsupported_kind',
                    kind: 'oauth',
                    providerEmail: 'oauth@example.com',
                    unsupportedSubtitleKey: 'connectedServices.detail.connectSetupTokenSubtitle',
                }],
            },
            setBindingForService,
            onOpenSettings,
        });

        const unsupportedOption = firstStaticSection(model).options.find((option) =>
            option.id === createReauthServiceOptionId('anthropic', 'oauth-work'));
        unsupportedOption?.onSelect?.();

        expect(unsupportedOption).toEqual(expect.objectContaining({
            id: createReauthServiceOptionId('anthropic', 'oauth-work'),
            subtitle: 'connectedServices.detail.connectSetupTokenSubtitle',
            rightAccessory: 'needs-reauth',
        }));
        expect(setBindingForService).not.toHaveBeenCalled();
        expect(onOpenSettings).toHaveBeenCalledWith('anthropic');
    });

    it('adds quota accessories to connected account rows', () => {
        const model = buildModel({
            bindingsByServiceId: { anthropic: { source: 'connected', profileId: 'work' } },
            quotaBadgesByKey: {
                'anthropic/work': [{ meterId: 'weekly', text: 'Weekly 18%' }],
            },
        });

        const accountOption = firstStaticSection(model).options[0];

        expect(model.selectedOptionId).toBe(createConnectedServiceOptionId('anthropic', 'work'));
        expect(accountOption?.rightAccessory).toBe('badges:Weekly 18%');
    });

    it('qualifies repeated service fallback rows for assistive technology', () => {
        const model = buildModel({
            supportedServiceIds: ['anthropic', 'openai-codex'],
            profileOptionsByServiceId: {
                anthropic: [],
                'openai-codex': [],
            },
            groupOptionsByServiceId: {},
            bindingsByServiceId: {
                anthropic: { source: 'native' },
                'openai-codex': { source: 'native' },
            },
        });

        const nativeRows = model.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .filter((option) => option.id.endsWith(':native'))
            .map((option) => option as unknown as { accessibilityLabel?: string });
        const connectRows = model.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .filter((option) => option.id.endsWith(':connect'))
            .map((option) => option as unknown as { accessibilityLabel?: string });

        expect(nativeRows.map((option) => option.accessibilityLabel)).toEqual([
            'service:anthropic · connectedServices.authModal.nativeAuthTitle',
            'service:openai-codex · connectedServices.authModal.nativeAuthTitle',
        ]);
        expect(connectRows.map((option) => option.accessibilityLabel)).toEqual([
            'service:anthropic · connectedServices.authModal.notConnectedTitle',
            'service:openai-codex · connectedServices.authModal.notConnectedTitle',
        ]);
    });
});
