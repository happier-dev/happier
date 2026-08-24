import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
    installConnectedServiceDetailShellMocks,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';
import { connectedServicesModuleState } from './connectedServicesTestHelpers';

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
const textSpies = vi.hoisted(() => ({
    translate: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}));

const authGroupApiSpies = vi.hoisted(() => ({
    listConnectedServiceAuthGroupsV3: vi.fn(),
    createConnectedServiceAuthGroupV3: vi.fn(),
    patchConnectedServiceAuthGroupV3: vi.fn(),
    deleteConnectedServiceAuthGroupV3: vi.fn(),
    addConnectedServiceAuthGroupMemberV3: vi.fn(),
    patchConnectedServiceAuthGroupMemberV3: vi.fn(),
    removeConnectedServiceAuthGroupMemberV3: vi.fn(),
    setConnectedServiceAuthGroupActiveProfileV3: vi.fn(),
}));

const syncSpies = vi.hoisted(() => ({
    refreshProfile: vi.fn(),
    applySettings: vi.fn(),
}));
const connectedServiceCredentialSpies = vi.hoisted(() => ({
    storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
    deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

const authState = vi.hoisted(() => ({
    credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as
        | { token: string; secret: string }
        | null,
}));

const featureEnabledById = vi.hoisted(() => new Map<string, boolean>());
const profileState = vi.hoisted(() => ({
    current: { connectedServicesV2: [] as unknown[] },
    listeners: new Set<() => void>(),
}));
const authoritativeGroupState = vi.hoisted(() => ({
    groups: [] as unknown[],
}));
const settingsState = vi.hoisted(() => ({
    current: {
        connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' } as Record<string, string>,
        connectedServicesProfileLabelByKey: {} as Record<string, string>,
        connectedServicesQuotaPinnedMeterIdsByKey: {},
        connectedServicesQuotaSummaryStrategyByKey: {},
        connectedServicesCollapsedItemKeysV1: {} as Record<string, boolean>,
    },
}));

function notifyProfileStateChanged() {
    for (const listener of profileState.listeners) {
        listener();
    }
}

function createProfileSnapshot(groups: unknown[] = []) {
    return {
        connectedServiceCredentialRevisionsV1: [],
        connectedServicesV2: [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', kind: 'oauth', providerEmail: 'backup@example.com' },
                ],
                groups,
            },
        ],
    };
}

function createAuthoritativeGroup(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'primary',
        displayName: 'Team pool',
        policy: {
            v: 1,
            strategy: 'priority',
            autoSwitch: true,
            switchOn: {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            },
            cooldownMs: 30_000,
            honorProviderResetsAt: true,
            autoRestorePrimaryWhenReset: false,
            maxSwitchesPerTurn: 1,
            maxSwitchesPerSessionHour: 3,
        },
        activeProfileId: 'work',
        generation: 2,
        state: {
            status: 'ready',
            cooldownUntilMs: 1_800_000_000_000,
        },
        createdAt: 1,
        updatedAt: 2,
        members: [
            {
                v: 1,
                serviceId: 'openai-codex',
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
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                priority: 20,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            },
        ],
        ...overrides,
    };
}

async function renderGroupsScreen() {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const screen = await renderScreen(<ConnectedServiceDetailView />);
    await flushAsyncHandlers();
    return screen;
}

/**
 * The redesigned controller defaults to the Accounts segment. Pools live behind
 * the `Pools` tab of `ConnectedServiceSegmentedShell`, so most pool assertions
 * select that segment first. The segmented tab bar is mocked to a passthrough
 * (see {@link installConnectedServiceDetailShellMocks}) so this just drives the
 * `onSelectTab('pools')` callback.
 */
async function selectPoolsSegment(screen: Awaited<ReturnType<typeof renderGroupsScreen>>) {
    await act(async () => {
        screen.findByTestId('connected-services-detail-shell:segment:pools')?.props.onPress?.();
        await flushAsyncHandlers();
    });
}

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'openai-codex' },
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
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: textSpies.translate });
    },
});
installConnectedServiceDetailShellMocks();

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledById.get(featureId) ?? true,
}));

vi.mock('@/sync/store/hooks', async () => {
    const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
    const React = await import('react');
    return {
        ...actual,
        useProfile: () => React.useSyncExternalStore(
            (listener) => {
                profileState.listeners.add(listener);
                return () => {
                    profileState.listeners.delete(listener);
                };
            },
            () => profileState.current,
            () => profileState.current,
        ),
        useSettings: () => settingsState.current,
    };
});

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshProfile: syncSpies.refreshProfile,
        applySettings: syncSpies.applySettings,
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => syncSpies.applySettings,
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
    storeConnectedServiceCredentialForAccount: connectedServiceCredentialSpies.storeConnectedServiceCredentialForAccount,
    deleteConnectedServiceCredentialForAccount: connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount,
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => authGroupApiSpies);

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee', updatedAt: 0 })),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
    requestConnectedServiceQuotaSnapshotRefresh: vi.fn(async () => true),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
    requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
    const React = require('react');
    type ItemRowActionsMockProps = React.PropsWithChildren<Record<string, unknown>>;
    return {
        ItemRowActions: (props: ItemRowActionsMockProps) => React.createElement('ItemRowActions', props, props.children),
    };
});

/**
 * Controller-level coverage for the redesigned segmented shell.
 *
 * Per-member management (set-active, add/remove member, member priority,
 * fallback row actions, cooldown retry, member-label confirmation) moved OUT of
 * this controller into `PoolDetailView` and is covered by `PoolDetailView.test.tsx`.
 * What remains the controller's responsibility — and is asserted here — is the
 * authoritative pool read path, the `PoolsList` rendering, the create-pool flow,
 * the disconnect-with-group-cleanup flow, and the fail-closed Pools-segment gate.
 */
describe('ConnectedServiceDetailView pools segment', () => {
    beforeEach(() => {
        modalSpies.prompt.mockReset();
        modalSpies.confirm.mockReset();
        modalSpies.alert.mockReset();
        textSpies.translate.mockClear();
        syncSpies.refreshProfile.mockReset();
        syncSpies.applySettings.mockReset();
        connectedServicesModuleState.searchParams = { serviceId: 'openai-codex' };
        connectedServiceCredentialSpies.storeConnectedServiceCredentialForAccount.mockClear();
        connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount.mockClear();
        authState.credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
        featureEnabledById.clear();
        settingsState.current = {
            connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
            connectedServicesProfileLabelByKey: {},
            connectedServicesQuotaPinnedMeterIdsByKey: {},
            connectedServicesQuotaSummaryStrategyByKey: {},
            connectedServicesCollapsedItemKeysV1: {},
        };
        profileState.current = createProfileSnapshot([
            {
                groupId: 'primary',
                displayName: 'Profile summary',
                activeProfileId: 'work',
                generation: 2,
                memberProfileIds: ['work', 'backup'],
            },
        ]);
        authoritativeGroupState.groups = [createAuthoritativeGroup()];
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockReset();
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementation(async () => authoritativeGroupState.groups);
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockReset();
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockReset();
        authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.deleteConnectedServiceAuthGroupV3.mockReset();
        authGroupApiSpies.deleteConnectedServiceAuthGroupV3.mockResolvedValue(true);
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockReset();
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup());
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockReset();
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockImplementation(async () => createAuthoritativeGroup());
        syncSpies.refreshProfile.mockResolvedValue(undefined);
    });

    it('loads authoritative groups from the v3 list API and renders them as pool rows', async () => {
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({ displayName: 'Authoritative pool' }),
        ];

        const screen = await renderGroupsScreen();
        await selectPoolsSegment(screen);

        // Authoritative read path (not the profile projection).
        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex' },
        );

        // PoolsList renders one drill-in row per authoritative group + a create card.
        const poolRow = screen.findByTestId('connected-services-pool:primary');
        expect(poolRow).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-action:create')).toBeTruthy();

        // The authoritative label wins over the equivalent profile-projection summary.
        const titles = screen.tree.root
            .findAll((node) => typeof node.props?.title === 'object')
            .map((node) => node.props.title);
        const renderedText = screen.getTextContent();
        expect(renderedText).toContain('Authoritative pool');
        expect(renderedText).not.toContain('Profile summary');
        expect(titles.length).toBeGreaterThan(0);
    });

    it('opens directly on the Pools segment when deep-linked with segment=pools', async () => {
        authoritativeGroupState.groups = [
            createAuthoritativeGroup({ displayName: 'Authoritative pool' }),
        ];
        connectedServicesModuleState.searchParams = { serviceId: 'openai-codex', segment: 'pools' };

        const screen = await renderGroupsScreen();
        // The one-shot segment initializer runs post-mount; flush its state + the PoolsList load.
        await act(async () => {
            await flushAsyncHandlers();
        });

        // No manual segment switch — the pools content is reachable immediately.
        expect(screen.findByTestId('connected-services-pool:primary')).toBeTruthy();
    });

    it('offers reconnect for a healthy OAuth account from the accounts list', async () => {
        const screen = await renderGroupsScreen();

        expect(screen.tree.root.findAll((node) => node.props?.children === 'work').length).toBeGreaterThan(0);

        const workActionHost = screen.tree.root
            .findAll((node) => (node.type as unknown) === 'ItemRowActions')
            .find((host) => host.props?.title === 'work@example.com');
        const actions = ((workActionHost?.props?.actions ?? []) as ReadonlyArray<{ id: string }>);

        expect(actions.some((action) => action.id === 'reconnect')).toBe(true);
    });

    it('opens pool detail when a pool row is pressed', async () => {
        const screen = await renderGroupsScreen();
        await selectPoolsSegment(screen);

        await screen.pressByTestIdAsync('connected-services-pool:primary');

        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/group',
            params: { serviceId: 'openai-codex', groupId: 'primary' },
        });
    });

    it('refetches authoritative groups when the service projection changes after a profile update', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        authoritativeGroupState.groups = [createAuthoritativeGroup({ displayName: 'Initial pool' })];

        const screen = await renderScreen(<ConnectedServiceDetailView />);
        await flushAsyncHandlers();
        await selectPoolsSegment(screen);
        expect(screen.getTextContent()).toContain('Initial pool');

        const listCallsBeforeProjectionChange = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;

        authoritativeGroupState.groups = [
            createAuthoritativeGroup({ displayName: 'Refetched pool', activeProfileId: 'backup', generation: 3 }),
        ];

        await act(async () => {
            profileState.current = {
                connectedServicesV2: [
                    {
                        serviceId: 'openai-codex',
                        profiles: [
                            { profileId: 'work', status: 'needs_reauth', providerEmail: 'work@example.com' },
                            { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                        ],
                        groups: [
                            {
                                groupId: 'primary',
                                displayName: 'Projected summary',
                                activeProfileId: 'backup',
                                generation: 3,
                                memberProfileIds: ['backup'],
                            },
                        ],
                    },
                ],
            };
            notifyProfileStateChanged();
            await flushAsyncHandlers();
        });
        await flushAsyncHandlers();

        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThan(
            listCallsBeforeProjectionChange,
        );
        expect(screen.getTextContent()).toContain('Refetched pool');
    });

    it('refetches authoritative groups after disconnect even when the service projection stays equivalent', async () => {
        const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
        settingsState.current = {
            ...settingsState.current,
            connectedServicesDefaultProfileByServiceId: {
                'openai-codex': 'work',
                'claude-subscription': 'leeroy',
            },
            connectedServicesProfileLabelByKey: {
                'openai-codex/work': 'Work account',
                'openai-codex/backup': 'Backup account',
            },
        };
        authoritativeGroupState.groups = [createAuthoritativeGroup({ displayName: 'Initial pool' })];
        syncSpies.refreshProfile.mockImplementation(async () => {
            profileState.current = createProfileSnapshot([
                {
                    groupId: 'primary',
                    displayName: 'Profile summary',
                    activeProfileId: 'work',
                    generation: 2,
                    memberProfileIds: ['work', 'backup'],
                },
            ]);
            notifyProfileStateChanged();
        });
        modalSpies.confirm.mockResolvedValueOnce(true);

        const screen = await renderScreen(<ConnectedServiceDetailView />);
        await flushAsyncHandlers();

        const listCallsBeforeDisconnect = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;
        authoritativeGroupState.groups = [createAuthoritativeGroup({ displayName: 'Refetched after disconnect' })];

        // Disconnect now lives on the AccountBlock kebab actions (Accounts segment).
        // Scope to the `work` account block (its title is the configured label).
        const workActionHost = screen.tree.root
            .findAll((node) => (node.type as unknown) === 'ItemRowActions')
            .find((host) => host.props?.title === 'Work account');
        const disconnect = ((workActionHost?.props?.actions ?? []) as ReadonlyArray<{ id: string; onPress: () => Promise<void> | void }>)
            .find((action) => action.id === 'disconnect');

        await act(async () => {
            await disconnect?.onPress();
            await flushAsyncHandlers();
        });

        // Group references are cleaned up because the disconnected profile belongs to a pool.
        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'modals.disconnect',
            'connectedServices.detail.disconnectGroupCleanupConfirmBody',
            expect.objectContaining({
                confirmText: 'modals.disconnect',
                cancelText: 'common.cancel',
            }),
        );
        const disconnectBodyCall = textSpies.translate.mock.calls.find(
            ([key]) => key === 'connectedServices.detail.disconnectGroupCleanupConfirmBody',
        );
        expect(disconnectBodyCall?.[1]).toEqual(expect.objectContaining({
            profileId: 'Work account · work@example.com · work',
        }));
        expect(connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', profileId: 'work', cleanupGroupReferences: true },
        );
        expect(syncSpies.applySettings).toHaveBeenCalledWith(
            expect.objectContaining({
                connectedServicesDefaultProfileByServiceId: { 'claude-subscription': 'leeroy' },
                connectedServicesProfileLabelByKey: { 'openai-codex/backup': 'Backup account' },
            }),
        );
        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThan(
            listCallsBeforeDisconnect,
        );
    });

    it('creates a pool from a single user-facing name prompt and refetches authoritative state', async () => {
        profileState.current = createProfileSnapshot([]);
        authoritativeGroupState.groups = [];
        const createdGroup = createAuthoritativeGroup({
            groupId: 'team-pool',
            displayName: 'Team Pool',
            activeProfileId: null,
            members: [],
        });
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockImplementation(async () => {
            authoritativeGroupState.groups = [createdGroup];
            return createdGroup;
        });
        modalSpies.prompt.mockResolvedValueOnce('Team Pool!');
        const screen = await renderGroupsScreen();
        await selectPoolsSegment(screen);
        const listCallsBeforeAction = authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length;

        await screen.pressByTestIdAsync('connected-services-pool-action:create');
        await flushAsyncHandlers();

        expect(modalSpies.prompt).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'team-pool',
                displayName: 'Team Pool!',
                members: [],
                activeProfileId: null,
            }),
        );
        expect(syncSpies.refreshProfile).toHaveBeenCalled();
        expect(authGroupApiSpies.listConnectedServiceAuthGroupsV3.mock.calls.length).toBeGreaterThan(listCallsBeforeAction);
        expect(screen.findByTestId('connected-services-pool:team-pool')).toBeTruthy();
    });

    it('infers a safe pool id when the display name has no slug characters', async () => {
        profileState.current = createProfileSnapshot([]);
        authoritativeGroupState.groups = [];
        const createdGroup = createAuthoritativeGroup({
            groupId: 'group',
            displayName: 'チーム',
            activeProfileId: null,
            members: [],
        });
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockImplementation(async () => {
            authoritativeGroupState.groups = [createdGroup];
            return createdGroup;
        });
        modalSpies.prompt.mockResolvedValueOnce('チーム');

        const screen = await renderGroupsScreen();
        await selectPoolsSegment(screen);
        await screen.pressByTestIdAsync('connected-services-pool-action:create');
        await flushAsyncHandlers();

        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'group',
                displayName: 'チーム',
            }),
        );
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('routes create-pool auth loss through the shared modal error path', async () => {
        profileState.current = createProfileSnapshot([]);
        authoritativeGroupState.groups = [];
        modalSpies.prompt.mockResolvedValueOnce('Team Pool');
        const screen = await renderGroupsScreen();
        await selectPoolsSegment(screen);

        authState.credentials = null;

        await expect(screen.pressByTestIdAsync('connected-services-pool-action:create')).resolves.toBeUndefined();
        await flushAsyncHandlers();

        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).not.toHaveBeenCalled();
        expect(modalSpies.alert).toHaveBeenCalledWith('common.error', 'Not authenticated');
    });

    it('fails closed: the Pools segment is hidden when account groups are disabled', async () => {
        featureEnabledById.set('connectedServices.accountGroups', false);

        const screen = await renderGroupsScreen();

        // No segmented tab bar / Pools tab and no PoolsList content is reachable.
        expect(screen.findByTestId('connected-services-detail-shell:segment:pools')).toBeNull();
        expect(screen.findAllByTestId('connected-services-pool:primary')).toHaveLength(0);
        expect(screen.findAllByTestId('connected-services-pool-action:create')).toHaveLength(0);
        // Accounts content still renders.
        expect(screen.findByTestId('connected-services-detail-shell')).toBeTruthy();
    });

    it('fails closed: the Pools segment is hidden when the service cannot configure pools', async () => {
        // github has no account-group configuration capability -> Pools is unreachable.
        connectedServicesModuleState.searchParams = { serviceId: 'github' };
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'github',
                    profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'work@example.com' }],
                    groups: [],
                },
            ],
        };
        authoritativeGroupState.groups = [];

        const screen = await renderGroupsScreen();

        expect(screen.findByTestId('connected-services-detail-shell:segment:pools')).toBeNull();
        expect(screen.findAllByTestId('connected-services-pool-action:create')).toHaveLength(0);
    });

    it('keeps the create-pool card enabled for a service that can configure pools even without runtime fallback', async () => {
        // gemini can configure pools (groupConfigurationSupported) but has no runtime fallback.
        connectedServicesModuleState.searchParams = { serviceId: 'gemini' };
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'gemini',
                    profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'work@example.com' }],
                    groups: [],
                },
            ],
        };
        authoritativeGroupState.groups = [];

        const screen = await renderGroupsScreen();
        await selectPoolsSegment(screen);

        // Read the create `Item` props directly (not the resolved host element).
        const createCard = screen.tree.root.find(
            (node) => node.props?.testID === 'connected-services-pool-action:create',
        );
        expect(createCard).toBeTruthy();
        expect(createCard.props.disabled).toBe(false);
        expect(createCard.props.subtitle).toBe('connectedServices.pools.create.subtitle');
        expect(typeof createCard.props.onPress).toBe('function');
    });
});
