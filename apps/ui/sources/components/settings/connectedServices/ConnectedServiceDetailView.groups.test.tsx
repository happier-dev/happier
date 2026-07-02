import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceAuthGroupV1Schema, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { connectedServicesModuleState, installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const promptSpy = vi.fn(async () => 'team');
const alertSpy = vi.fn(async () => {});
const confirmSpy = vi.fn(async () => true);
const listGroupsSpy = vi.fn(async () => ({ groups: [] as Array<Record<string, unknown>> }));
const addMemberSpy = vi.fn(async (): Promise<{ group: ConnectedServiceAuthGroupV1 }> => ({ group: buildGroupForMocks() }));
const removeMemberSpy = vi.fn(async (): Promise<{ group: ConnectedServiceAuthGroupV1 }> => ({ group: buildGroupForMocks() }));
const patchGroupSpy = vi.fn(async (): Promise<{ group: ConnectedServiceAuthGroupV1 }> => ({ group: buildGroupForMocks() }));
const patchMemberSpy = vi.fn(async (): Promise<{ group: ConnectedServiceAuthGroupV1 }> => ({ group: buildGroupForMocks() }));
const createGroupSpy = vi.fn(async (): Promise<{ group: ConnectedServiceAuthGroupV1 }> => ({
    group: buildGroupForMocks(),
}));
const deleteCredentialSpy = vi.fn(async () => {});
const refreshProfileSpy = vi.fn(async () => {});
const applySettingsSpy = vi.fn(async () => {});
const setActiveProfileSpy = vi.fn(async (): Promise<{ group: ConnectedServiceAuthGroupV1 }> => ({
    group: buildGroupForMocks(),
}));
const featureEnabledById = vi.hoisted(() => new Map<string, boolean>());
const authState = vi.hoisted(() => ({
    credentials: {
        token: 't',
        secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url'),
    } as { token: string; secret: string } | null,
}));
const profileState = vi.hoisted(() => ({
    connectedServicesV2: [
        {
            serviceId: 'anthropic',
            profiles: [
                { profileId: 'primary', status: 'connected', providerEmail: 'primary@example.com' },
                { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                { profileId: 'outsider', status: 'connected', providerEmail: 'outsider@example.com' },
            ],
            groups: [
                {
                    v: 1,
                    serviceId: 'anthropic',
                    groupId: 'summary',
                    displayName: 'Summary Team',
                    policy: { v: 1 },
                    activeProfileId: 'primary',
                    generation: 1,
                    state: {},
                    createdAt: 1,
                    updatedAt: 1,
                    members: [
                        {
                            v: 1,
                            serviceId: 'anthropic',
                            groupId: 'summary',
                            profileId: 'primary',
                            priority: 10,
                            enabled: true,
                            state: {},
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            v: 1,
                            serviceId: 'anthropic',
                            groupId: 'summary',
                            profileId: 'backup',
                            priority: 20,
                            enabled: true,
                            state: {},
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
            ],
        },
    ] as Array<Record<string, unknown>>,
}));

function createConnectedServiceApiError(
    code: string,
    props: Readonly<{ status?: number; resetAtMs?: number; generation?: number }> = {},
): Error & { code: string; status?: number; resetAtMs?: number; generation?: number } {
    const error = new Error(code) as Error & { code: string; status?: number; resetAtMs?: number; generation?: number };
    error.code = code;
    error.status = props.status;
    error.resetAtMs = props.resetAtMs;
    error.generation = props.generation;
    return error;
}

function buildGroupForMocks(overrides: Partial<ConnectedServiceAuthGroupV1> = {}): ConnectedServiceAuthGroupV1 {
    return ConnectedServiceAuthGroupV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        groupId: 'team',
        displayName: 'team',
        policy: { v: 1 },
        activeProfileId: 'primary',
        generation: 1,
        state: {},
        createdAt: 1,
        updatedAt: 1,
        members: [],
        ...overrides,
    });
}

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'anthropic' },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: promptSpy,
                alert: alertSpy,
                confirm: confirmSpy,
            },
        }).module;
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledById.get(featureId) ?? featureId !== 'connectedServices.quotas',
}));

vi.mock('@/sync/store/hooks', async () => {
    const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
    return {
        ...actual,
        useProfile: () => ({
            connectedServicesV2: profileState.connectedServicesV2,
        }),
        useSettings: () => ({
            connectedServicesDefaultProfileByServiceId: { anthropic: 'primary' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesQuotaPinnedMeterIdsByKey: {},
            connectedServicesQuotaSummaryStrategyByKey: {},
        }),
    };
});

function isItemRowActionsNode(node: renderer.ReactTestInstance): boolean {
    return String(node.type) === 'ItemRowActions';
}

const translatedGroupStatusCases = [
    { status: 'switching', expectedKey: 'connectedServices.detail.groups.statusSwitching' },
    { status: 'error', expectedKey: 'connectedServices.detail.groups.statusError' },
    { status: 'unknown', expectedKey: 'connectedServices.detail.groups.statusUnknown' },
] as const;

vi.mock('@/sync/sync', () => ({
    sync: { refreshProfile: refreshProfileSpy, applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsSpy,
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => ({
    listConnectedServiceAuthGroupsV3: listGroupsSpy,
    createConnectedServiceAuthGroupV3: createGroupSpy,
    addConnectedServiceAuthGroupMemberV3: addMemberSpy,
    patchConnectedServiceAuthGroupV3: patchGroupSpy,
    patchConnectedServiceAuthGroupMemberV3: patchMemberSpy,
    removeConnectedServiceAuthGroupMemberV3: removeMemberSpy,
    deleteConnectedServiceAuthGroupV3: vi.fn(async () => true),
    setConnectedServiceAuthGroupActiveProfileV3: setActiveProfileSpy,
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
    storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
    deleteConnectedServiceCredentialForAccount: deleteCredentialSpy,
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
    const ReactModule = require('react') as typeof React;
    return {
        ItemRowActions: (props: Record<string, unknown>) => ReactModule.createElement('ItemRowActions', props),
    };
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => {
    const ReactModule = require('react') as typeof React;
    return {
        DropdownMenu: (props: Record<string, unknown>) => ReactModule.createElement('DropdownMenu', props),
    };
});

describe('ConnectedServiceDetailView account groups', () => {
    function buildGroup(overrides: Partial<ConnectedServiceAuthGroupV1> = {}): ConnectedServiceAuthGroupV1 {
        return ConnectedServiceAuthGroupV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            groupId: 'team',
            displayName: 'Authoritative Team',
            policy: { v: 1 },
            activeProfileId: 'primary',
            generation: 1,
            state: {},
            createdAt: 1,
            updatedAt: 1,
            members: [
                {
                    v: 1,
                    serviceId: 'anthropic',
                    groupId: 'team',
                    profileId: 'primary',
                    priority: 10,
                    enabled: true,
                    state: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    v: 1,
                    serviceId: 'anthropic',
                    groupId: 'team',
                    profileId: 'backup',
                    priority: 20,
                    enabled: true,
                    state: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            ...overrides,
        });
    }

    beforeEach(() => {
        promptSpy.mockClear();
        alertSpy.mockClear();
        confirmSpy.mockClear();
        listGroupsSpy.mockReset();
        createGroupSpy.mockClear();
        addMemberSpy.mockClear();
        patchGroupSpy.mockClear();
        patchMemberSpy.mockClear();
        removeMemberSpy.mockClear();
        deleteCredentialSpy.mockClear();
        setActiveProfileSpy.mockClear();
        refreshProfileSpy.mockClear();
        applySettingsSpy.mockClear();
        featureEnabledById.clear();
        connectedServicesModuleState.searchParams = { serviceId: 'anthropic' };
        authState.credentials = {
            token: 't',
            secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url'),
        };
        profileState.connectedServicesV2 = [
            {
                serviceId: 'anthropic',
                profiles: [
                    { profileId: 'primary', status: 'connected', providerEmail: 'primary@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                    { profileId: 'outsider', status: 'connected', providerEmail: 'outsider@example.com' },
                ],
                groups: [
                    {
                        v: 1,
                        serviceId: 'anthropic',
                        groupId: 'summary',
                        displayName: 'Summary Team',
                        policy: { v: 1 },
                        activeProfileId: 'primary',
                        generation: 1,
                        state: {},
                        createdAt: 1,
                        updatedAt: 1,
                        members: [
                            {
                                v: 1,
                                serviceId: 'anthropic',
                                groupId: 'summary',
                                profileId: 'primary',
                                priority: 10,
                                enabled: true,
                                state: {},
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                v: 1,
                                serviceId: 'anthropic',
                                groupId: 'summary',
                                profileId: 'backup',
                                priority: 20,
                                enabled: true,
                                state: {},
                                createdAt: 1,
                                updatedAt: 1,
                            },
                        ],
                    },
                ],
            },
        ];
        listGroupsSpy.mockResolvedValue({
            groups: [buildGroup()],
        });
    });

    it('loads authoritative groups, renders status metadata, and creates groups from a single user-facing name prompt', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const { t } = await import('@/text');
        const cooldownUntilMs = Date.UTC(2026, 4, 19, 12, 30, 0);
        const authoritativeGroup = buildGroup({
            groupId: 'team',
            displayName: 'Authoritative Team',
            state: {
                status: 'exhausted',
                cooldownUntilMs,
            },
        });
        const createdGroup = buildGroup({
            groupId: 'fallback-team',
            displayName: 'Fallback Team!',
            activeProfileId: 'backup',
            members: [
                {
                    v: 1,
                    serviceId: 'anthropic',
                    groupId: 'fallback-team',
                    profileId: 'backup',
                    priority: 10,
                    enabled: true,
                    state: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        });
        listGroupsSpy
            .mockResolvedValueOnce({ groups: [authoritativeGroup] })
            .mockRejectedValueOnce(new Error('refresh failed'));
        createGroupSpy.mockResolvedValueOnce({ group: createdGroup });
        promptSpy.mockResolvedValueOnce('Fallback Team!');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});

        const authoritativeItems = tree.root.findAll((n) =>
            n.props?.testID === 'connected-services-auth-group:team' && typeof n.props?.title === 'string');
        expect(authoritativeItems).toHaveLength(1);
        expect(authoritativeItems[0]?.props.title).toBe('Authoritative Team');
        expect(String(authoritativeItems[0]?.props.subtitle ?? '')).toContain(t('connectedServices.detail.groups.statusExhausted'));
        expect(String(authoritativeItems[0]?.props.subtitle ?? '')).toContain(
            t('connectedServices.detail.groups.cooldown', { time: new Date(cooldownUntilMs).toLocaleString() }),
        );
        expect(tree.findAll((n) => n.props?.testID === 'connected-services-action:create-group').length).toBeGreaterThan(0);

        const createAction = tree.findAll((n) => n.props?.testID === 'connected-services-action:create-group')[0]!;
        await act(async () => {
            await pressTestInstanceAsync(createAction);
        });
        await act(async () => {});

        expect(promptSpy).toHaveBeenCalledTimes(1);
        expect(createGroupSpy).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'anthropic',
                groupId: 'fallback-team',
                displayName: 'Fallback Team!',
                activeProfileId: null,
                members: [],
            }),
        );
        expect(refreshProfileSpy).toHaveBeenCalledTimes(1);
        expect(listGroupsSpy).toHaveBeenCalledTimes(2);

        const createdItems = tree.root.findAll((n) =>
            n.props?.testID === 'connected-services-auth-group:fallback-team' && typeof n.props?.title === 'string');
        expect(createdItems).toHaveLength(1);
        expect(createdItems[0]?.props.title).toBe('Fallback Team!');
    });

    it('infers a safe group id when the display name has no slug characters', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const createdGroup = buildGroup({
            groupId: 'group',
            displayName: 'チーム',
            activeProfileId: null,
            members: [],
        });
        listGroupsSpy.mockResolvedValue({ groups: [] });
        createGroupSpy.mockResolvedValueOnce({ group: createdGroup });
        promptSpy.mockResolvedValueOnce('チーム');

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});
        const createAction = tree.findAll((n) => n.props?.testID === 'connected-services-action:create-group')[0]!;
        await act(async () => {
            await pressTestInstanceAsync(createAction);
        });

        expect(createGroupSpy).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'anthropic',
                groupId: 'group',
                displayName: 'チーム',
            }),
        );
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('keeps group creation visible but disabled when no runtime can switch the service', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        connectedServicesModuleState.searchParams = { serviceId: 'github' };
        profileState.connectedServicesV2 = [
            {
                serviceId: 'github',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                ],
                groups: [],
            },
        ];
        listGroupsSpy.mockResolvedValueOnce({ groups: [] });

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});
        const createAction = tree.root.find((n) => n.props?.testID === 'connected-services-action:create-group');

        expect(createAction.props).toEqual(expect.objectContaining({
            disabled: true,
            subtitle: 'connectedServices.detail.groupActions.runtimeFallbackUnsupported',
            onPress: undefined,
        }));
        expect(createGroupSpy).not.toHaveBeenCalled();
    });

    it('keeps group creation enabled when a service can configure groups even without runtime fallback', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        connectedServicesModuleState.searchParams = { serviceId: 'gemini' };
        profileState.connectedServicesV2 = [
            {
                serviceId: 'gemini',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                ],
                groups: [],
            },
        ];
        listGroupsSpy.mockResolvedValueOnce({ groups: [] });

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});
        const createAction = tree.root.find((n) => n.props?.testID === 'connected-services-action:create-group');

        expect(createAction.props).toEqual(expect.objectContaining({
            disabled: false,
            subtitle: 'connectedServices.detail.groups.createSubtitle',
        }));
        expect(typeof createAction.props.onPress).toBe('function');
    });

    it('opens group details from the row edit action and uses a profile dropdown for members', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const { connectedServicesModuleState } = await import('./connectedServicesTestHelpers');
        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});

        const groupActions = tree.root.findAll(isItemRowActionsNode)
            .find((node) => node.props.title === 'Authoritative Team');
        const actions = groupActions?.props.actions as ReadonlyArray<{ id: string; onPress: () => void }> | undefined;
        const dropdown = tree.root
            .findAllByType('DropdownMenu' as any)
            .find((node) => node.props.itemTrigger?.itemProps?.testID === 'connected-services-auth-group:team:members');
        const items = dropdown?.props.items as ReadonlyArray<{ id: string; rightElement?: React.ReactNode }> | undefined;

        await act(async () => {
            actions?.find((action) => action.id === 'connected-services-group:team:action:edit')?.onPress();
            await Promise.resolve();
        });
        await act(async () => {
            dropdown?.props.onSelect('outsider');
            await Promise.resolve();
            dropdown?.props.onSelect('primary');
            await Promise.resolve();
        });

        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/group',
            params: { serviceId: 'anthropic', groupId: 'team' },
        });
        expect(items?.map((item) => item.id)).toEqual(['primary', 'backup', 'outsider']);
        expect(items?.find((item) => item.id === 'primary')?.rightElement).toBeTruthy();
        expect(items?.find((item) => item.id === 'outsider')?.rightElement).toBeNull();
        expect(addMemberSpy).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'team', profileId: 'outsider', priority: 100, enabled: true, expectedGeneration: 1 },
        );
        expect(confirmSpy).toHaveBeenCalledWith(
            'connectedServices.detail.groupActions.removeMemberConfirmTitle',
            'connectedServices.detail.groupActions.removeMemberConfirmBody',
            expect.objectContaining({ confirmText: 'common.remove' }),
        );
        expect(removeMemberSpy).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'team', profileId: 'primary', expectedGeneration: 1 },
        );
    });

    it('renders service detail group rows with full management actions', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const exhaustedUntilMs = Date.UTC(2026, 4, 19, 12, 30, 0);
        listGroupsSpy.mockResolvedValueOnce({
            groups: [
                buildGroup({
                    state: { status: 'ready' },
                    members: [
                        {
                            v: 1,
                            serviceId: 'anthropic',
                            groupId: 'team',
                            profileId: 'primary',
                            priority: 10,
                            enabled: true,
                            state: {},
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            v: 1,
                            serviceId: 'anthropic',
                            groupId: 'team',
                            profileId: 'backup',
                            priority: 20,
                            enabled: false,
                            state: { exhaustedUntilMs, lastFailureKind: 'usage_limit' },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                }),
            ],
        });

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});
        const groupActions = tree.root.findAll(isItemRowActionsNode)
            .find((node) => node.props.title === 'Authoritative Team')?.props.actions as
                | ReadonlyArray<{ id: string }>
                | undefined;
        const backupMemberRow = tree.root.findAll((node) =>
            node.props?.testID === 'connected-services-group:team:member:backup'
            && typeof node.props?.subtitle === 'string')[0] ?? null;
        const backupMemberActions = tree.root.findAll(isItemRowActionsNode)
            .find((node) => node.props.overflowTriggerTestID === 'connected-services-group:team:member:backup:actions')?.props.actions as
                | ReadonlyArray<{ id: string }>
                | undefined;

        expect(groupActions?.map((action) => action.id)).toEqual([
            'connected-services-group:team:action:edit',
            'connected-services-group:team:action:enable-fallback',
            'connected-services-group:team:action:manual-strategy',
            'connected-services-group:team:action:delete',
        ]);
        expect(backupMemberRow).toBeTruthy();
        expect(String(backupMemberRow?.props.subtitle ?? '')).toContain('connectedServices.detail.groups.memberDisabled');
        expect(backupMemberActions?.map((action) => action.id)).toEqual([
            'connected-services-group:team:member:backup:action:set-active',
            'connected-services-group:team:member:backup:action:enable',
            'connected-services-group:team:member:backup:action:priority',
            'connected-services-group:team:member:backup:action:remove',
        ]);
    });

    it('disables active profile switching when account fallback is disabled', async () => {
        featureEnabledById.set('connectedServices.accountFallback', false);
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});
        const actions = tree.root
            .findAll(isItemRowActionsNode)
            .flatMap((node) => Array.isArray(node.props.actions)
                ? node.props.actions as ReadonlyArray<{ id: string; disabled?: boolean }>
                : []);
        const backupAction = actions?.find((action) =>
            action.id === 'connected-services-group:team:member:backup:action:set-active');

        expect(backupAction).toEqual(expect.objectContaining({ disabled: true }));
    });

    it('only offers active member actions for members of the group', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});
        const actions = tree.root
            .findAll(isItemRowActionsNode)
            .flatMap((node) => Array.isArray(node.props.actions)
                ? node.props.actions as ReadonlyArray<{ id: string }>
                : []);

        expect(actions.some((action) =>
            action.id === 'connected-services-group:team:member:primary:action:set-active')).toBe(true);
        expect(actions.some((action) =>
            action.id === 'connected-services-group:team:member:backup:action:set-active')).toBe(true);
        expect(actions.some((action) =>
            action.id === 'connected-services-group:team:member:outsider:action:set-active')).toBe(false);
    });

    it('confirms and retries manual active member switches with a runtime cooldown override', async () => {
        const resetAtMs = Date.UTC(2026, 5, 8, 17, 30, 0);
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        listGroupsSpy.mockResolvedValueOnce({
            groups: [buildGroup({
                members: [
                    {
                        v: 1,
                        serviceId: 'anthropic',
                        groupId: 'team',
                        profileId: 'primary',
                        priority: 10,
                        enabled: true,
                        state: {},
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        v: 1,
                        serviceId: 'anthropic',
                        groupId: 'team',
                        profileId: 'backup',
                        priority: 20,
                        enabled: true,
                        state: { quotaExhaustedUntilMs: resetAtMs },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            })],
        });
        confirmSpy.mockResolvedValueOnce(true);
        setActiveProfileSpy
            .mockRejectedValueOnce(createConnectedServiceApiError('connect_group_profile_runtime_cooldown', { status: 409, resetAtMs }))
            .mockResolvedValueOnce({ group: buildGroup({ activeProfileId: 'backup' }) });

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});
        const backupAction = tree.root
            .findAll(isItemRowActionsNode)
            .flatMap((node) => Array.isArray(node.props.actions)
                ? node.props.actions as ReadonlyArray<{ id: string; onPress: () => void }>
                : [])
            .find((action) => action.id === 'connected-services-group:team:member:backup:action:set-active');

        await act(async () => {
            backupAction?.onPress();
            await Promise.resolve();
        });

        expect(confirmSpy).toHaveBeenCalledWith(
            'connectedServices.errors.runtimeCooldownOverrideTitle',
            'connectedServices.errors.runtimeCooldownOverrideBody',
            expect.objectContaining({ confirmText: 'connectedServices.errors.runtimeCooldownOverrideConfirm' }),
        );
        expect(setActiveProfileSpy).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'team', profileId: 'backup', expectedGeneration: 1 },
        );
        expect(setActiveProfileSpy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'anthropic',
                groupId: 'team',
                profileId: 'backup',
                expectedGeneration: 1,
                overrideRuntimeCooldown: true,
            },
        );
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it.each(translatedGroupStatusCases)('renders translated $status group status labels', async ({ status, expectedKey }) => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const { t } = await import('@/text');
        listGroupsSpy.mockResolvedValueOnce({
            groups: [buildGroup({ state: { status } })],
        });

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});

        const authoritativeItem = tree.root.findAll((n) =>
            n.props?.testID === 'connected-services-auth-group:team' && typeof n.props?.title === 'string')[0];
        const subtitle = String(authoritativeItem?.props.subtitle ?? '');

        expect(subtitle).toContain(t(expectedKey));
        expect(subtitle).not.toContain(status);
    });

    it('uses the translated unknown label for unexpected group statuses', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const { t } = await import('@/text');
        listGroupsSpy.mockResolvedValueOnce({
            groups: [{
                ...buildGroup(),
                state: { status: 'surprise' },
            }],
        });

        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});

        const authoritativeItem = tree.root.findAll((n) =>
            n.props?.testID === 'connected-services-auth-group:team' && typeof n.props?.title === 'string')[0];
        const subtitle = String(authoritativeItem?.props.subtitle ?? '');

        expect(subtitle).toContain(t('connectedServices.detail.groups.statusUnknown'));
        expect(subtitle).not.toContain('surprise');
    });

    it('refetches authoritative groups after disconnect refreshes the connected-service projection', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        listGroupsSpy
            .mockResolvedValueOnce({ groups: [buildGroup({ displayName: 'Authoritative Team' })] })
            .mockResolvedValueOnce({ groups: [buildGroup({ displayName: 'Refetched Team' })] });

        const screen = await renderScreen(<ConnectedServiceDetailView />);
        await act(async () => {});

        const readGroupTitles = () => screen.tree.root
            .findAll((node) =>
                typeof node.props?.title === 'string'
                && String(node.props?.testID ?? '').startsWith('connected-services-auth-group:'),
            )
            .map((node) => String(node.props.title));

        expect(readGroupTitles()).toContain('Authoritative Team');
        expect(listGroupsSpy).toHaveBeenCalledTimes(1);

        const profileActions = screen.tree.root.findAll(isItemRowActionsNode)
            .find((node) => node.props.title === 'primary');
        const disconnectAction = (profileActions?.props.actions as ReadonlyArray<{ id: string; onPress: () => void }> | undefined)
            ?.find((action) => action.id === 'disconnect');

        await act(async () => {
            disconnectAction?.onPress();
        });
        await act(async () => {});

        expect(confirmSpy).toHaveBeenCalledWith(
            'modals.disconnect',
            'connectedServices.detail.disconnectGroupCleanupConfirmBody',
            expect.objectContaining({ confirmText: 'modals.disconnect' }),
        );
        expect(deleteCredentialSpy).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', profileId: 'primary', cleanupGroupReferences: true },
        );
        expect(refreshProfileSpy).toHaveBeenCalledTimes(1);
        expect(listGroupsSpy).toHaveBeenCalledTimes(2);
        expect(readGroupTitles()).toContain('Refetched Team');
    });

    it('routes missing auth after mount through the shared modal error path for group mutations', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        const { t } = await import('@/text');
        const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
        await act(async () => {});

        authState.credentials = null;
        promptSpy.mockResolvedValueOnce('late-auth');

        const createAction = tree.root.findByProps({ testID: 'connected-services-action:create-group' });
        await act(async () => {
            createAction.props.onPress();
            await Promise.resolve();
        });

        expect(createGroupSpy).not.toHaveBeenCalled();
        expect(alertSpy).toHaveBeenCalledWith(t('common.error'), 'Not authenticated');
    });
});
