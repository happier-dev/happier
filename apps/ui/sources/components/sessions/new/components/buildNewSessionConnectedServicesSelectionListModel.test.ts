import { describe, expect, it, vi } from 'vitest';

import {
    buildNewSessionConnectedServicesSelectionListModel,
    createConnectedServiceGroupOptionId,
    createConnectedServiceOptionId,
    createNativeServiceOptionId,
    createReauthServiceOptionId,
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
    it('puts connected account rows first and binds the selected account directly', () => {
        const setBindingForService = vi.fn();
        const model = buildModel({ setBindingForService });

        const accountOption = firstStaticSection(model).options[0];
        expect(accountOption).toEqual(expect.objectContaining({
            id: createConnectedServiceOptionId('anthropic', 'work'),
            label: 'work@example.com',
            subtitle: 'work',
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
            subtitle: 'Active work@example.com · work',
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
