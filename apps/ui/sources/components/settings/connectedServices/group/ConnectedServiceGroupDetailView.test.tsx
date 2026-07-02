import React from 'react';
import { act } from 'react-test-renderer';
import { ConnectedServiceAuthGroupV1Schema, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { connectedServicesModuleState, installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncHandlers() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const modalSpies = vi.hoisted(() => ({
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
}));

const authGroupApiSpies = vi.hoisted(() => ({
    listConnectedServiceAuthGroupsV3: vi.fn(),
    patchConnectedServiceAuthGroupV3: vi.fn(),
    patchConnectedServiceAuthGroupMemberV3: vi.fn(),
    addConnectedServiceAuthGroupMemberV3: vi.fn(),
    removeConnectedServiceAuthGroupMemberV3: vi.fn(),
    setConnectedServiceAuthGroupActiveProfileV3: vi.fn(),
}));

const syncSpies = vi.hoisted(() => ({
    refreshProfile: vi.fn(),
}));

const authState = vi.hoisted(() => ({
    credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as
        | { token: string; secret: string }
        | null,
}));

const profileState = vi.hoisted(() => ({
    current: {
        connectedServicesV2: [
            {
                serviceId: 'anthropic',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
            },
        ],
    },
}));

const authoritativeGroupState = vi.hoisted(() => ({
    groups: [] as ConnectedServiceAuthGroupV1[],
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

function createAuthoritativeGroup(overrides: Partial<ConnectedServiceAuthGroupV1> = {}): ConnectedServiceAuthGroupV1 {
    return ConnectedServiceAuthGroupV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        groupId: 'primary',
        displayName: 'Team pool',
        policy: { v: 1, strategy: 'priority', autoSwitch: false },
        activeProfileId: 'work',
        generation: 2,
        state: { status: 'ready' },
        createdAt: 1,
        updatedAt: 2,
        members: [
            {
                v: 1,
                serviceId: 'anthropic',
                groupId: 'primary',
                profileId: 'work',
                priority: 10,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            },
        ],
        ...overrides,
    });
}

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'anthropic', groupId: 'primary' },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalSpies.prompt,
                confirm: modalSpies.confirm,
                alert: modalSpies.alert,
            },
        }).module;
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => (
        featureId === 'connectedServices'
        || featureId === 'connectedServices.accountGroups'
        || featureId === 'connectedServices.accountFallback'
    ),
}));

vi.mock('@/sync/store/hooks', async () => {
    const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
    return {
        ...actual,
        useProfile: () => profileState.current,
        useSettings: () => ({
            connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesQuotaPinnedMeterIdsByKey: {},
            connectedServicesQuotaSummaryStrategyByKey: {},
        }),
    };
});

vi.mock('@/sync/sync', () => ({
    sync: { refreshProfile: syncSpies.refreshProfile },
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => authGroupApiSpies);

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => {
    const ReactModule = require('react') as typeof React;
    return {
        DropdownMenu: (props: Record<string, unknown>) => ReactModule.createElement('DropdownMenu', props),
    };
});

vi.mock('@/components/ui/lists/ItemRowActions', () => {
    const ReactModule = require('react') as typeof React;
    return {
        ItemRowActions: (props: Record<string, unknown>) => ReactModule.createElement('ItemRowActions', props),
    };
});

async function renderGroupDetailScreen() {
    const { ConnectedServiceGroupDetailView } = await import('./ConnectedServiceGroupDetailView');
    const screen = await renderScreen(<ConnectedServiceGroupDetailView />);
    await flushAsyncHandlers();
    return screen;
}

describe('ConnectedServiceGroupDetailView', () => {
    beforeEach(() => {
        modalSpies.prompt.mockReset();
        modalSpies.confirm.mockReset();
        modalSpies.alert.mockReset();
        syncSpies.refreshProfile.mockReset();
        connectedServicesModuleState.searchParams = { serviceId: 'anthropic', groupId: 'primary' };
        authState.credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                    ],
                },
            ],
        };
        authoritativeGroupState.groups = [createAuthoritativeGroup()];
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockReset();
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementation(async () => ({ groups: authoritativeGroupState.groups }));
        authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockReset();
        authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockImplementation(async () => ({ group: createAuthoritativeGroup() }));
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockImplementation(async () => ({ group: createAuthoritativeGroup() }));
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockImplementation(async () => ({ group: createAuthoritativeGroup() }));
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockImplementation(async () => ({ group: createAuthoritativeGroup({ members: [] }) }));
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockReset();
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockImplementation(async () => ({ group: createAuthoritativeGroup({ activeProfileId: 'backup' }) }));
    });

    it('renders the selected group with editable settings and profile member dropdown', async () => {
        const screen = await renderGroupDetailScreen();
        const dropdown = screen.tree.root
            .findAllByType('DropdownMenu' as any)
            .find((node) => node.props.itemTrigger?.itemProps?.testID === 'connected-services-group-detail:members');
        const items = dropdown?.props.items as ReadonlyArray<{ id: string; rightElement?: React.ReactNode }> | undefined;

        expect(screen.findByTestId('connected-services-group-detail:name')).toBeTruthy();
        expect(screen.findByTestId('connected-services-group-detail:auto-switch')).toBeTruthy();
        expect(dropdown).toBeTruthy();
        expect(items?.map((item) => item.id)).toEqual(['work', 'backup']);
        expect(items?.find((item) => item.id === 'work')?.rightElement).toBeTruthy();
        expect(items?.find((item) => item.id === 'backup')?.rightElement).toBeNull();
    });

    it('disables fallback controls when no runtime supports switching the service', async () => {
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'github',
                    profiles: [
                        { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                    ],
                },
            ],
        };
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                serviceId: 'github',
                members: [
                    {
                        v: 1,
                        serviceId: 'github',
                        groupId: 'primary',
                        profileId: 'work',
                        priority: 10,
                        enabled: true,
                        state: {},
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    {
                        v: 1,
                        serviceId: 'github',
                        groupId: 'primary',
                        profileId: 'backup',
                        priority: 20,
                        enabled: true,
                        state: {},
                        createdAt: 1,
                        updatedAt: 2,
                    },
                ],
            }),
        ];
        connectedServicesModuleState.searchParams = { serviceId: 'github', groupId: 'primary' };
        const screen = await renderGroupDetailScreen();
        const autoSwitchItem = screen.tree.root.find((node) =>
            node.props?.testID === 'connected-services-group-detail:auto-switch'
            && node.props?.title === 'connectedServices.detail.groupDetail.autoSwitchTitle');
        const backupActions = screen.tree.root
            .findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'backup')?.props.actions as
                | ReadonlyArray<{ id: string; onPress?: () => void; disabled?: boolean; subtitle?: string }>
                | undefined;
        const setActiveAction = backupActions?.find((action) => action.id.endsWith(':set-active'));

        expect(autoSwitchItem.props).toEqual(expect.objectContaining({
            disabled: true,
            subtitle: 'connectedServices.detail.groupActions.runtimeFallbackUnsupported',
            onPress: undefined,
        }));
        expect(setActiveAction).toEqual(expect.objectContaining({
            disabled: true,
            subtitle: 'connectedServices.detail.groupActions.runtimeFallbackUnsupported',
        }));
        await act(async () => {
            setActiveAction?.onPress?.();
            await flushAsyncHandlers();
        });
        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).not.toHaveBeenCalled();
    });

    it('updates group name, policy, and dropdown membership through v3 group APIs', async () => {
        modalSpies.prompt.mockResolvedValueOnce('Renamed pool');
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderGroupDetailScreen();

        await screen.pressByTestIdAsync('connected-services-group-detail:name');
        await screen.pressByTestIdAsync('connected-services-group-detail:auto-switch');
        const strategyDropdown = screen.tree.root
            .findAllByType('DropdownMenu' as any)
            .find((node) => node.props.itemTrigger?.itemProps?.testID === 'connected-services-group-detail:strategy');
        await act(async () => {
            strategyDropdown?.props.onSelect('least_limited');
            await flushAsyncHandlers();
        });
        const membersDropdown = screen.tree.root
            .findAllByType('DropdownMenu' as any)
            .find((node) => node.props.itemTrigger?.itemProps?.testID === 'connected-services-group-detail:members');
        await act(async () => {
            membersDropdown?.props.onSelect('backup');
            await flushAsyncHandlers();
            membersDropdown?.props.onSelect('work');
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', patch: { displayName: 'Renamed pool' } },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', patch: { policy: expect.objectContaining({ autoSwitch: true }), expectedGeneration: 2 } },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', patch: { policy: expect.objectContaining({ strategy: 'least_limited' }), expectedGeneration: 2 } },
        );
        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', profileId: 'backup', priority: 100, enabled: true, expectedGeneration: 2 },
        );
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', profileId: 'work', expectedGeneration: 2 },
        );
        expect(syncSpies.refreshProfile).toHaveBeenCalled();
    });

    it('updates group quota fallback thresholds through policy patch APIs', async () => {
        modalSpies.prompt.mockResolvedValueOnce('9').mockResolvedValueOnce('2');
        const screen = await renderGroupDetailScreen();

        await screen.pressByTestIdAsync('connected-services-group-detail:soft-switch-threshold');
        await screen.pressByTestIdAsync('connected-services-group-detail:stale-probe-after');

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', patch: { policy: expect.objectContaining({ softSwitchRemainingPercent: 9 }), expectedGeneration: 2 } },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', patch: { policy: expect.objectContaining({ probeIfSnapshotOlderThanMs: 120_000 }), expectedGeneration: 2 } },
        );
    });

    it('renders member status rows and updates active member, enabled state, and priority', async () => {
        modalSpies.prompt.mockResolvedValueOnce('5');
        const exhaustedUntilMs = Date.UTC(2026, 6, 19, 12, 30, 0);
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                members: [
                    {
                        v: 1,
                        serviceId: 'anthropic',
                        groupId: 'primary',
                        profileId: 'work',
                        priority: 10,
                        enabled: true,
                        state: {},
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    {
                        v: 1,
                        serviceId: 'anthropic',
                        groupId: 'primary',
                        profileId: 'backup',
                        priority: 20,
                        enabled: false,
                        state: { exhaustedUntilMs, lastFailureKind: 'usage_limit' },
                        createdAt: 1,
                        updatedAt: 2,
                    },
                ],
            }),
        ];

        const screen = await renderGroupDetailScreen();
        const { t } = await import('@/text');
        const backupRow = screen.tree.root.findAll((node) =>
            node.props?.testID === 'connected-services-group-detail:member:backup'
            && typeof node.props?.subtitle === 'string')[0] ?? null;
        expect(backupRow).toBeTruthy();
        const backupSubtitle = String(backupRow?.props.subtitle ?? '');
        const backupActions = screen.tree.root
            .findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'backup')?.props.actions as ReadonlyArray<{ id: string; onPress: () => void }> | undefined;

        expect(screen.findByTestId('connected-services-group-detail:member:work')).toBeTruthy();
        expect(backupSubtitle).toContain(t('connectedServices.detail.groups.memberDisabled'));
        expect(backupSubtitle).toContain(t('connectedServices.detail.groups.memberPriority', { priority: 20 }));
        expect(backupSubtitle).toContain(t('connectedServices.detail.groups.memberExhaustedUntil', { time: new Date(exhaustedUntilMs).toLocaleString() }));
        expect(backupActions?.map((action) => action.id)).toEqual([
            'connected-services-group:primary:member:backup:action:set-active',
            'connected-services-group:primary:member:backup:action:enable',
            'connected-services-group:primary:member:backup:action:priority',
            'connected-services-group:primary:member:backup:action:remove',
        ]);

        await act(async () => {
            backupActions?.find((action) => action.id.endsWith(':set-active'))?.onPress();
            await flushAsyncHandlers();
            backupActions?.find((action) => action.id.endsWith(':enable'))?.onPress();
            await flushAsyncHandlers();
            backupActions?.find((action) => action.id.endsWith(':priority'))?.onPress();
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', profileId: 'backup', expectedGeneration: 2 },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', profileId: 'backup', patch: { enabled: true, expectedGeneration: 2 } },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', profileId: 'backup', patch: { priority: 5, expectedGeneration: 2 } },
        );
    });

    it('confirms and retries manual active member switches with a runtime cooldown override', async () => {
        const resetAtMs = Date.UTC(2026, 5, 8, 17, 30, 0);
        modalSpies.confirm.mockResolvedValueOnce(true);
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3
            .mockRejectedValueOnce(createConnectedServiceApiError('connect_group_profile_runtime_cooldown', { status: 409, resetAtMs }))
            .mockResolvedValueOnce({ group: createAuthoritativeGroup({ activeProfileId: 'backup' }) });
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({
                members: [
                    {
                        v: 1,
                        serviceId: 'anthropic',
                        groupId: 'primary',
                        profileId: 'work',
                        priority: 10,
                        enabled: true,
                        state: {},
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    {
                        v: 1,
                        serviceId: 'anthropic',
                        groupId: 'primary',
                        profileId: 'backup',
                        priority: 20,
                        enabled: true,
                        state: { quotaExhaustedUntilMs: resetAtMs },
                        createdAt: 1,
                        updatedAt: 2,
                    },
                ],
            }),
        ];
        const screen = await renderGroupDetailScreen();
        const backupActions = screen.tree.root
            .findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'backup')?.props.actions as ReadonlyArray<{ id: string; onPress: () => void }> | undefined;

        await act(async () => {
            backupActions?.find((action) => action.id.endsWith(':set-active'))?.onPress();
            await flushAsyncHandlers();
        });

        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'connectedServices.errors.runtimeCooldownOverrideTitle',
            'connectedServices.errors.runtimeCooldownOverrideBody',
            expect.objectContaining({ confirmText: 'connectedServices.errors.runtimeCooldownOverrideConfirm' }),
        );
        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ token: 't' }),
            { serviceId: 'anthropic', groupId: 'primary', profileId: 'backup', expectedGeneration: 2 },
        );
        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'anthropic',
                groupId: 'primary',
                profileId: 'backup',
                expectedGeneration: 2,
                overrideRuntimeCooldown: true,
            },
        );
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });
});
