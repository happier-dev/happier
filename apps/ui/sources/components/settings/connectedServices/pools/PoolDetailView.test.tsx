import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import { renderScreen } from '@/dev/testkit';

import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from '../connectedServicesTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncHandlers() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const modalSpies = vi.hoisted(() => ({
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
    show: vi.fn((_config: unknown) => 'modal-id'),
}));
const textSpies = vi.hoisted(() => ({
    translate: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}));

const authGroupApiSpies = vi.hoisted(() => ({
    listConnectedServiceAuthGroupsV3: vi.fn(),
    addConnectedServiceAuthGroupMemberV3: vi.fn(),
    patchConnectedServiceAuthGroupV3: vi.fn(),
    patchConnectedServiceAuthGroupMemberV3: vi.fn(),
    removeConnectedServiceAuthGroupMemberV3: vi.fn(),
    setConnectedServiceAuthGroupActiveProfileV3: vi.fn(),
    deleteConnectedServiceAuthGroupV3: vi.fn(),
}));

const syncSpies = vi.hoisted(() => ({
    refreshProfile: vi.fn(),
}));

const quotaSnapshotsState = vi.hoisted(() => ({
    snapshotsByKey: {} as Record<string, unknown>,
    loadingByKey: {} as Record<string, boolean>,
    requestedProfiles: [] as ReadonlyArray<Readonly<{ serviceId: string; profileId: string }>>,
}));

const authState = vi.hoisted(() => ({
    credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as
        | { token: string; secret: string }
        | null,
}));

const featureEnabledById = vi.hoisted(() => new Map<string, boolean>());
const profileState = vi.hoisted(() => ({
    current: {
        connectedServicesV2: [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
            },
        ],
    } as {
        connectedServicesV2: Array<{
            serviceId: string;
            profiles: Array<{ profileId: string; status: string; providerEmail: string }>;
            groups?: Array<{
                groupId: string;
                displayName: string;
                activeProfileId: string;
                generation: number;
                memberProfileIds: string[];
            }>;
        }>;
    },
}));

const settingsState = vi.hoisted(() => ({
    current: {
        connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
        connectedServicesProfileLabelByKey: {} as Record<string, string>,
        connectedServicesQuotaPinnedMeterIdsByKey: {},
        connectedServicesQuotaSummaryStrategyByKey: {},
    },
}));

const machineSessionState = vi.hoisted(() => ({
    machines: [] as ReadonlyArray<Record<string, unknown>>,
    sessions: null as ReadonlyArray<Record<string, unknown>> | null,
}));

const authoritativeGroupState = vi.hoisted(() => ({
    groups: [] as ReturnType<typeof createAuthoritativeGroup>[],
}));

// AccountBlock is owned by another lane; render a passthrough that surfaces the
// props this view wires so behaviour (variant/enable/order/actions) is asserted
// without pulling the quota-snapshot hook + Reanimated body.
vi.mock('@/components/settings/connectedServices/account/AccountBlock', () => {
    const ReactModule = require('react');
    return {
        AccountBlock: (props: Record<string, unknown>) => ReactModule.createElement('AccountBlock', props),
    };
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

function createAuthoritativeGroup(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'primary',
        displayName: 'Team pool',
        policy: {
            v: 1,
            strategy: 'priority',
            autoSwitch: false,
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
            softSwitchRemainingPercent: 15,
            probeIfSnapshotOlderThanMs: 300_000,
            recoveryMode: 'switch_or_wait',
        },
        activeProfileId: 'work',
        generation: 2,
        state: { status: 'ready' },
        createdAt: 1,
        updatedAt: 2,
        members: [
            {
                v: 1,
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                priority: 100,
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
                priority: 200,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 2,
            },
        ],
        ...overrides,
    };
}

function createStructuredConnectedServiceError(
    code: string,
    fields: Readonly<{ status?: number; generation?: number }> = {},
): Error & { code: string; status?: number; generation?: number } {
    const error = new Error(code) as Error & { code: string; status?: number; generation?: number };
    error.name = 'ConnectedServiceApiError';
    error.code = code;
    error.status = fields.status;
    error.generation = fields.generation;
    return error;
}

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'openai-codex', groupId: 'primary' },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalSpies.prompt,
                confirm: modalSpies.confirm,
                alert: modalSpies.alert,
                show: modalSpies.show,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: textSpies.translate });
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledById.get(featureId) ?? true,
}));

vi.mock('@/sync/store/hooks', async () => {
    const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
    return {
        ...actual,
        useProfile: () => profileState.current,
        useSettings: () => settingsState.current,
        useAllMachines: () => machineSessionState.machines,
    };
});

vi.mock('@/sync/domains/state/storage', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage');
    return {
        ...actual,
        useAllMachines: () => machineSessionState.machines,
        useProfile: () => profileState.current,
        useSessions: () => machineSessionState.sessions,
    };
});

vi.mock('@/sync/sync', () => ({
    sync: { refreshProfile: syncSpies.refreshProfile },
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots', () => ({
    useConnectedServiceQuotaSnapshots: (profiles: ReadonlyArray<Readonly<{ serviceId: string; profileId: string }>>) => {
        quotaSnapshotsState.requestedProfiles = profiles;
        return {
            snapshotsByKey: quotaSnapshotsState.snapshotsByKey,
            loadingByKey: quotaSnapshotsState.loadingByKey,
            refreshAll: vi.fn(),
            isRefreshing: false,
        };
    },
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => authGroupApiSpies);


vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => {
    const ReactModule = require('react');
    return {
        DropdownMenu: (props: Record<string, unknown>) => ReactModule.createElement('DropdownMenu', props),
    };
});

type ReorderGesture = {
    __kind: string;
    __config: Record<string, unknown>;
    __handlers: Record<string, (...args: any[]) => void>;
};

type AccountBlockNodeProps = {
    profileId: string;
    title?: string;
    identityLabel?: string | null;
    status?: string;
    variant?: string;
    enabled?: boolean;
    onToggleEnabled?: (next: boolean) => void;
    isDefault?: boolean;
    isActive?: boolean;
    onSetActive?: () => void;
    actions?: ReadonlyArray<{ id: string; disabled?: boolean; onPress?: () => void; subtitle?: string }>;
    reorderGesture?: ReorderGesture | null;
};

function onlineMachine(id: string) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        revokedAt: null,
        metadata: {
            host: id,
            platform: 'darwin',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/tmp/happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function connectedServiceGroupSession(params: Readonly<{
    id: string;
    machineId: string;
    groupId: string;
}>) {
    return {
        id: params.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        presence: 'online',
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        metadata: {
            path: '/repo',
            machineId: params.machineId,
            agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                backendMode: 'appServer',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'work',
            }),
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: params.groupId,
                    },
                },
            },
        },
        agentState: null,
    };
}

/**
 * Pull the inline-reorder pan gesture wired to a member row. `AccountBlock` now
 * receives the gesture directly (it renders the `GestureDetector` INLINE itself,
 * mirroring SessionItem), so a present `reorderGesture` of `__kind: 'pan'` proves
 * the drag handle is actually wired on this row.
 */
function getMemberReorderGesture(
    screen: Awaited<ReturnType<typeof renderPoolDetail>>,
    profileId: string,
): ReorderGesture {
    const block = findMemberBlocks(screen).find((candidate) => candidate.profileId === profileId);
    const gesture = block?.reorderGesture;
    if (!gesture) throw new Error(`expected a bound reorder gesture for member "${profileId}"`);
    return gesture;
}

async function renderPoolDetail() {
    const { PoolDetailView } = await import('./PoolDetailView');
    const screen = await renderScreen(<PoolDetailView />);
    await flushAsyncHandlers();
    // Provider pool settings load on first render (they sit behind the agent catalog's import chain).
    await act(async () => {
        await vi.dynamicImportSettled();
    });
    await flushAsyncHandlers();
    return screen;
}

function findMemberBlocks(screen: Awaited<ReturnType<typeof renderPoolDetail>>): AccountBlockNodeProps[] {
    return screen.tree.root
        .findAllByType('AccountBlock' as never)
        .map((node) => node.props as AccountBlockNodeProps);
}

function findDropdown(screen: Awaited<ReturnType<typeof renderPoolDetail>>, testID: string) {
    return screen.tree.root
        .findAllByType('DropdownMenu' as never)
        .find((node) => node.props.itemTrigger?.itemProps?.testID === testID);
}

/** The membership multi-select — the only menu that stays open across selections. */
function findMembersDropdown(screen: Awaited<ReturnType<typeof renderPoolDetail>>) {
    return screen.tree.root
        .findAllByType('DropdownMenu' as never)
        .find((node) => node.props.closeOnSelect === false);
}

function findQuotaLimitsDropdown(screen: Awaited<ReturnType<typeof renderPoolDetail>>) {
    return screen.tree.root
        .findAllByType('DropdownMenu' as never)
        .find((node) => (node.props.items as ReadonlyArray<{ testID?: string }> | undefined)
            ?.some((item) => item.testID?.startsWith('connected-services-pool-detail:quota-limits:option:')));
}

/**
 * Drives the membership multi-select the way a user does: open the menu, toggle
 * the given profiles, then close it — which is what commits the batch.
 */
async function editMembership(
    screen: Awaited<ReturnType<typeof renderPoolDetail>>,
    toggledProfileIds: ReadonlyArray<string>,
) {
    await act(async () => {
        findMembersDropdown(screen)?.props.onOpenChange?.(true);
        await flushAsyncHandlers();
    });
    for (const profileId of toggledProfileIds) {
        await act(async () => {
            findMembersDropdown(screen)?.props.onSelect?.(profileId);
            await flushAsyncHandlers();
        });
    }
    await act(async () => {
        findMembersDropdown(screen)?.props.onOpenChange?.(false);
        await flushAsyncHandlers();
    });
}

/** Expand the "Advanced" disclosure so its lesser-used controls render. */
async function expandAdvanced(screen: Awaited<ReturnType<typeof renderPoolDetail>>) {
    await act(async () => {
        screen.findByTestId('connected-services-pool-detail:advanced:header')?.props.onPress?.();
        await flushAsyncHandlers();
    });
}

beforeEach(() => {
    modalSpies.prompt.mockReset();
    modalSpies.confirm.mockReset();
    modalSpies.alert.mockReset();
    modalSpies.show.mockReset();
    modalSpies.show.mockReturnValue('modal-id');
    textSpies.translate.mockClear();
    syncSpies.refreshProfile.mockReset();
    syncSpies.refreshProfile.mockResolvedValue(undefined);
    connectedServicesModuleState.searchParams = { serviceId: 'openai-codex', groupId: 'primary' };
    featureEnabledById.clear();
    settingsState.current = {
        connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
        connectedServicesProfileLabelByKey: {},
        connectedServicesQuotaPinnedMeterIdsByKey: {},
        connectedServicesQuotaSummaryStrategyByKey: {},
    };
    profileState.current = {
        connectedServicesV2: [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                    { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                ],
                groups: [
                    {
                        groupId: 'primary',
                        displayName: 'Team pool',
                        activeProfileId: 'work',
                        generation: 2,
                        memberProfileIds: ['work', 'backup'],
                    },
                ],
            },
        ],
    };
    machineSessionState.machines = [onlineMachine('machine-1')];
    machineSessionState.sessions = [
        connectedServiceGroupSession({ id: 'session-owner', machineId: 'machine-1', groupId: 'primary' }),
    ];
    authState.credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
    quotaSnapshotsState.snapshotsByKey = {
        'openai-codex/work': {
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [
                { meterId: 'standard:primary', providerLimitId: 'standard', label: 'Standard · Primary', used: null, limit: null, unit: 'unknown', utilizationPct: 10, resetsAt: null, status: 'ok', details: {} },
                { meterId: 'spark:primary', providerLimitId: 'spark', label: 'Spark · Primary', used: null, limit: null, unit: 'unknown', utilizationPct: 20, resetsAt: null, status: 'ok', details: {} },
            ],
        },
    };
    quotaSnapshotsState.loadingByKey = {};
    quotaSnapshotsState.requestedProfiles = [];
    authoritativeGroupState.groups = [createAuthoritativeGroup()];
    authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockReset();
    authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementation(async () => authoritativeGroupState.groups);
    authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockReset();
    authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({ generation: 3 }));
    authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockReset();
    authGroupApiSpies.patchConnectedServiceAuthGroupV3.mockImplementation(async () => createAuthoritativeGroup());
    authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockReset();
    authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({ generation: 3 }));
    authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockReset();
    authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({
        generation: 3,
        members: [createAuthoritativeGroup().members[0]],
    }));
    authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockReset();
    authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockImplementation(async () => createAuthoritativeGroup({ activeProfileId: 'backup', generation: 3 }));
    authGroupApiSpies.deleteConnectedServiceAuthGroupV3.mockReset();
    authGroupApiSpies.deleteConnectedServiceAuthGroupV3.mockImplementation(async () => true);
});

describe('PoolDetailView', () => {
    it.each(['claude-subscription', 'anthropic'].flatMap((serviceId) => (
        [undefined, false, true].map((currentValue) => ({ serviceId, currentValue }))
    )))('renders $serviceId native usage-limit waiting ($currentValue) and saves changes with the pool generation', async ({ serviceId, currentValue }) => {
        connectedServicesModuleState.searchParams = { serviceId, groupId: 'primary' };
        const group = createAuthoritativeGroup({ serviceId });
        authoritativeGroupState.groups = [{
            ...group,
            policy: { ...group.policy, ...(currentValue === undefined ? {} : { claudeCodeAutoContinueAtUsageLimit: currentValue }) },
        }];
        profileState.current = {
            connectedServicesV2: [{
                serviceId,
                profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'work@example.com' }],
            }],
        };
        const screen = await renderPoolDetail();
        const toggle = screen.findByTestId('connected-services-pool-detail:claude-auto-continue:toggle');

        expect(toggle).toBeTruthy();
        expect(toggle?.props.value).toBe(currentValue === true);
        await act(async () => {
            toggle?.props.onValueChange(currentValue !== true);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId,
                groupId: 'primary',
                patch: {
                    expectedGeneration: 2,
                    policy: { claudeCodeAutoContinueAtUsageLimit: currentValue !== true },
                },
            },
        );
    });

    it('disables Claude native waiting policy changes when account fallback is disabled', async () => {
        connectedServicesModuleState.searchParams = { serviceId: 'claude-subscription', groupId: 'primary' };
        authoritativeGroupState.groups = [createAuthoritativeGroup({ serviceId: 'claude-subscription' })];
        featureEnabledById.set('connectedServices.accountFallback', false);
        const screen = await renderPoolDetail();

        const toggle = screen.findByTestId('connected-services-pool-detail:claude-auto-continue:toggle');
        expect(toggle?.props.disabled).toBe(true);
        expect(toggle?.props.onValueChange).toBeUndefined();
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).not.toHaveBeenCalled();
    });

    it('adds a connected profile to a freshly-created empty pool with the current generation', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            activeProfileId: null,
            generation: 2,
            members: [],
        })];
        const screen = await renderPoolDetail();

        await editMembership(screen, ['backup']);

        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                priority: 100,
                enabled: true,
                expectedGeneration: 2,
            },
        );
        // Adding alone is not destructive, so it must not raise a confirmation.
        expect(modalSpies.confirm).not.toHaveBeenCalled();
    });

    it('allows retryable refresh-failure profiles to be added to a pool', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            activeProfileId: null,
            generation: 2,
            members: [],
        })];
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        { profileId: 'retryable', status: 'refresh_failed_retryable', providerEmail: 'retryable@example.com' },
                    ],
                },
            ],
        };
        const screen = await renderPoolDetail();

        const candidateIds = (findMembersDropdown(screen)?.props.items as ReadonlyArray<{ id: string }>)
            .map((item) => item.id);
        expect(candidateIds).toContain('retryable');

        await editMembership(screen, ['retryable']);

        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'retryable',
                expectedGeneration: 2,
            }),
        );
    });

    it('removes an existing member after confirmation with the current generation', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderPoolDetail();
        const backup = findMemberBlocks(screen).find((block) => block.profileId === 'backup');
        const remove = backup?.actions?.find((action) => action.id.endsWith(':remove'));
        expect(remove).toBeTruthy();

        await act(async () => {
            remove?.onPress?.();
            await flushAsyncHandlers();
        });

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                expectedGeneration: 2,
            },
        );
    });

    it('offers one multi-select listing members and joinable non-members, with members checked', async () => {
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                        { profileId: 'extra', status: 'connected', providerEmail: 'extra@example.com' },
                    ],
                },
            ],
        };
        const screen = await renderPoolDetail();

        const dropdown = findMembersDropdown(screen);
        expect((dropdown?.props.items as ReadonlyArray<{ id: string }>).map((item) => item.id))
            .toEqual(['work', 'backup', 'extra']);
        // The two superseded affordances are gone: no alert-picker, no second modal.
        expect(screen.findByTestId('connected-services-pool-detail:add-member')).toBeFalsy();
        expect(screen.findByTestId('connected-services-pool-detail:edit-members')).toBeFalsy();
    });

    it('labels the members trigger with a title and a count, never an unbounded name list', async () => {
        const screen = await renderPoolDetail();

        const trigger = findMembersDropdown(screen)?.props.trigger as (
            (state: { toggle: () => void; open: boolean }) => React.ReactElement<{
                title?: string;
                subtitle?: string;
                detail?: string;
            }>
        );
        const row = trigger({ toggle: () => {}, open: false });

        expect(row.props.title).toBe('connectedServices.detail.groupActions.manageMembersTitle');
        expect(row.props.subtitle).toBe('connectedServices.detail.groupActions.manageMembersSubtitle');
        // `detail` renders in the row's RIGHT section with no width cap, so a
        // joined member list there squeezes the title out of the row entirely.
        expect(row.props.detail).toBeUndefined();
    });

    it('commits nothing while the menu is open, so a multi-toggle edit is one batch', async () => {
        modalSpies.confirm.mockResolvedValue(true);
        const screen = await renderPoolDetail();

        await act(async () => {
            findMembersDropdown(screen)?.props.onOpenChange?.(true);
            await flushAsyncHandlers();
        });
        await act(async () => {
            findMembersDropdown(screen)?.props.onSelect?.('backup');
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).not.toHaveBeenCalled();
        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).not.toHaveBeenCalled();
    });

    it('confirms once before committing a batch that removes members, and applies nothing when declined', async () => {
        modalSpies.confirm.mockResolvedValue(false);
        const screen = await renderPoolDetail();

        await editMembership(screen, ['backup']);

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).not.toHaveBeenCalled();
    });

    it('batch-applies the membership diff (add + remove) through the canonical mutations, threading the generation', async () => {
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        { profileId: 'work', status: 'connected', providerEmail: 'work@example.com' },
                        { profileId: 'backup', status: 'connected', providerEmail: 'backup@example.com' },
                        { profileId: 'extra', status: 'connected', providerEmail: 'extra@example.com' },
                    ],
                    groups: [
                        {
                            groupId: 'primary',
                            displayName: 'Team pool',
                            activeProfileId: 'work',
                            generation: 2,
                            memberProfileIds: ['work', 'backup'],
                        },
                    ],
                },
            ],
        };
        authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({
            generation: 3,
            members: [createAuthoritativeGroup().members[0]],
        }));
        authGroupApiSpies.addConnectedServiceAuthGroupMemberV3.mockImplementation(async () => createAuthoritativeGroup({ generation: 4 }));

        modalSpies.confirm.mockResolvedValue(true);
        const screen = await renderPoolDetail();

        await editMembership(screen, ['backup', 'extra']);

        // Remove threads the starting generation (2).
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                expectedGeneration: 2,
            },
        );
        // Add threads the generation the remove returned (3), priority = max+step.
        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'extra',
                priority: 300,
                enabled: true,
                expectedGeneration: 3,
            },
        );
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('applies no membership mutation when the draft ends up matching the current members', async () => {
        const screen = await renderPoolDetail();

        // Toggle off then back on: the net diff is empty, so nothing is committed
        // and no destructive confirmation is raised.
        await editMembership(screen, ['backup', 'backup']);

        expect(authGroupApiSpies.addConnectedServiceAuthGroupMemberV3).not.toHaveBeenCalled();
        expect(authGroupApiSpies.removeConnectedServiceAuthGroupMemberV3).not.toHaveBeenCalled();
        expect(modalSpies.confirm).not.toHaveBeenCalled();
    });

    it('does not render pool-not-found while the first authoritative group load is pending', async () => {
        let resolveGroups: ((groups: unknown[]) => void) | undefined;
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementationOnce(
            () => new Promise((resolve) => {
                resolveGroups = resolve;
            }),
        );

        const { PoolDetailView } = await import('./PoolDetailView');
        const screen = await renderScreen(<PoolDetailView />);

        expect(screen.getTextContent()).not.toContain('connectedServices.detail.groupDetail.missingTitle');
        expect(screen.findAllByTestId('connected-services-pool-detail')).toHaveLength(0);

        await act(async () => {
            resolveGroups?.([createAuthoritativeGroup()]);
            await flushAsyncHandlers();
        });

        expect(screen.findByTestId('connected-services-pool-detail')).toBeTruthy();
    });

    it('renders members as pool-member AccountBlocks in fallback (priority) order', async () => {
        const screen = await renderPoolDetail();

        const blocks = findMemberBlocks(screen);
        expect(blocks.map((block) => block.profileId)).toEqual(['work', 'backup']);
        expect(blocks.every((block) => block.variant === 'poolMember')).toBe(true);
        // The active member is marked active in-list via the radio (`isActive`).
        expect(blocks.find((block) => block.profileId === 'work')?.isActive).toBe(true);
        expect(blocks.find((block) => block.profileId === 'backup')?.isActive).toBe(false);

        expect(screen.findByTestId('connected-services-pool-detail:summary')).toBeTruthy();
    });

    it('commits manual active-profile switching while every bound daemon is offline', async () => {
        machineSessionState.machines = [onlineMachine('machine-arbitrary')];
        machineSessionState.sessions = [
            connectedServiceGroupSession({ id: 'session-other-group', machineId: 'machine-arbitrary', groupId: 'secondary' }),
        ];
        const screen = await renderPoolDetail();
        const backup = findMemberBlocks(screen).find((block) => block.profileId === 'backup');
        const setActive = backup?.actions?.find((action) => action.id.endsWith(':set-active'));

        expect(backup?.onSetActive).toBeTypeOf('function');
        expect(setActive?.disabled).toBe(false);
        expect(setActive?.subtitle).toBeUndefined();

        await act(async () => {
            backup?.onSetActive?.();
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                expectedGeneration: 2,
            },
        );
    });

    it('shows durable server selection truth without claiming that every daemon has converged', async () => {
        const screen = await renderPoolDetail();

        const status = screen.findByTestId('connected-services-pool-detail:server-active-status');
        expect(status).toBeTruthy();
        expect(screen.getTextContent()).toContain('connectedServices.pools.detail.serverActiveStatusSubtitle');
    });

    it('does not claim a durable active account before the pool has one', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({ activeProfileId: null, members: [] })];

        const screen = await renderPoolDetail();

        expect(screen.findByTestId('connected-services-pool-detail:server-active-status')).toBeNull();
    });

    it('keeps the committed server selection pending when the local target disappears after CAS', async () => {
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockImplementationOnce(async () => {
            const committed = createAuthoritativeGroup({ activeProfileId: 'backup', generation: 3 });
            authoritativeGroupState.groups = [committed];
            machineSessionState.machines = [];
            machineSessionState.sessions = [];
            return committed;
        });
        const screen = await renderPoolDetail();

        await act(async () => {
            findMemberBlocks(screen).find((block) => block.profileId === 'backup')?.onSetActive?.();
            await flushAsyncHandlers();
        });

        expect(findMemberBlocks(screen).find((block) => block.profileId === 'backup')?.isActive).toBe(true);
        expect(screen.findByTestId('connected-services-pool-detail:server-active-status')).toBeTruthy();
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('keeps server truth unchanged when the active-profile CAS conflicts', async () => {
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockRejectedValueOnce(
            createStructuredConnectedServiceError('connect_group_generation_conflict', { status: 409, generation: 3 }),
        );
        const screen = await renderPoolDetail();

        await act(async () => {
            findMemberBlocks(screen).find((block) => block.profileId === 'backup')?.onSetActive?.();
            await flushAsyncHandlers();
        });

        expect(findMemberBlocks(screen).find((block) => block.profileId === 'work')?.isActive).toBe(true);
        expect(findMemberBlocks(screen).find((block) => block.profileId === 'backup')?.isActive).toBe(false);
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
    });

    it('lets a newer authoritative generation supersede the just-committed selection', async () => {
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3
            .mockImplementationOnce(async () => {
                authoritativeGroupState.groups = [createAuthoritativeGroup({ activeProfileId: 'work', generation: 4 })];
                return createAuthoritativeGroup({ activeProfileId: 'backup', generation: 3 });
            })
            .mockImplementationOnce(async (_credentials, params) => {
                const committed = createAuthoritativeGroup({ activeProfileId: params.profileId, generation: 5 });
                authoritativeGroupState.groups = [committed];
                return committed;
            });
        const screen = await renderPoolDetail();

        await act(async () => {
            findMemberBlocks(screen).find((block) => block.profileId === 'backup')?.onSetActive?.();
            await flushAsyncHandlers();
        });
        expect(findMemberBlocks(screen).find((block) => block.profileId === 'work')?.isActive).toBe(true);

        await act(async () => {
            findMemberBlocks(screen).find((block) => block.profileId === 'backup')?.onSetActive?.();
            await flushAsyncHandlers();
        });
        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({ profileId: 'backup', expectedGeneration: 4 }),
        );
    });

    it('switches back with a forward CAS against the freshly observed generation', async () => {
        authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3.mockImplementation(async (_credentials, params) => {
            const current = authoritativeGroupState.groups[0] ?? createAuthoritativeGroup();
            const committed = createAuthoritativeGroup({
                activeProfileId: params.profileId,
                generation: current.generation + 1,
            });
            authoritativeGroupState.groups = [committed];
            return committed;
        });
        const screen = await renderPoolDetail();

        await act(async () => {
            findMemberBlocks(screen).find((block) => block.profileId === 'backup')?.onSetActive?.();
            await flushAsyncHandlers();
        });
        await act(async () => {
            findMemberBlocks(screen).find((block) => block.profileId === 'work')?.onSetActive?.();
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.setConnectedServiceAuthGroupActiveProfileV3).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                expectedGeneration: 3,
            },
        );
    });

    it('passes credential health to pool member AccountBlocks with dominance over runtime blockers', async () => {
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
                            displayName: 'Team pool',
                            activeProfileId: 'work',
                            generation: 2,
                            memberProfileIds: ['work', 'backup'],
                        },
                    ],
                },
            ],
        };

        const screen = await renderPoolDetail();
        const work = findMemberBlocks(screen).find((block) => block.profileId === 'work');

        expect(work).toMatchObject({ status: 'needs_reauth' });
    });

    it('keeps stable profile ids visible for labelled pool members with provider email', async () => {
        settingsState.current.connectedServicesProfileLabelByKey = {
            'openai-codex/work': 'batiplus',
        };

        const screen = await renderPoolDetail();
        const work = findMemberBlocks(screen).find((block) => block.profileId === 'work');

        expect(work).toMatchObject({
            title: 'batiplus',
            identityLabel: 'work@example.com · work',
        });
    });

    it('toggles a member enable Switch through the member patch API with the generation', async () => {
        const screen = await renderPoolDetail();
        const backup = findMemberBlocks(screen).find((block) => block.profileId === 'backup');

        await act(async () => {
            backup?.onToggleEnabled?.(false);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { enabled: false, expectedGeneration: 2 },
            },
        );
    });

    it('reorders members via the Move up/down accessible fallback, writing spaced priorities with the generation', async () => {
        const screen = await renderPoolDetail();
        const backupBlock = findMemberBlocks(screen).find((block) => block.profileId === 'backup');
        const moveUp = backupBlock?.actions?.find((action) => action.id.endsWith(':move-up'));
        expect(moveUp).toBeTruthy();
        expect(moveUp?.disabled).toBe(false);

        await act(async () => {
            moveUp?.onPress?.();
            await flushAsyncHandlers();
        });

        // backup moves to the front -> it takes priority step 100, work moves to 200.
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { priority: 100, expectedGeneration: 2 },
            },
        );
        // Second patch threads the bumped generation returned by the first patch.
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                patch: { priority: 200, expectedGeneration: 3 },
            },
        );
    });

    it('binds an inline pan reorder gesture to every member row in a multi-member pool', async () => {
        // The handle is rendered INLINE by AccountBlock (the proven web-safe
        // pattern), so PoolDetailView hands each row its pan gesture directly.
        // A present `__kind: 'pan'` gesture proves the drag handle is wired on web.
        const screen = await renderPoolDetail();
        const blocks = findMemberBlocks(screen);
        expect(blocks.length).toBeGreaterThanOrEqual(2);
        for (const block of blocks) {
            expect(block.reorderGesture?.__kind).toBe('pan');
        }
    });

    it('renders the single list-level drop overlay (blue insertion line) for the members list', async () => {
        const screen = await renderPoolDetail();
        expect(screen.findByTestId('connected-services-pool-detail:drop-overlay')).toBeTruthy();
    });

    it('commits a drag reorder (start -> update past a row -> end) with spaced priorities and the threaded generation', async () => {
        const screen = await renderPoolDetail();
        const gesture = getMemberReorderGesture(screen, 'backup');

        // Drive the bound pan gesture: drag `backup` up past `work` (fallback row
        // height 56 -> a -60 translation crosses `work`'s midpoint), then release.
        await act(async () => {
            gesture.__handlers.onStart?.({});
            gesture.__handlers.onUpdate?.({ translationY: -60 });
            gesture.__handlers.onEnd?.({});
            await flushAsyncHandlers();
        });

        // backup -> front (priority step 100, gen 2); work -> 200 threading gen 3.
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { priority: 100, expectedGeneration: 2 },
            },
        );
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'work',
                patch: { priority: 200, expectedGeneration: 3 },
            },
        );
    });

    it('applies the dropped order optimistically before the priority patches resolve', async () => {
        // Hold the first member patch pending so we can observe the pre-persistence
        // state. Before the fix, the order only changed as each sequential patch
        // resolved + re-upserted (a chaotic reshuffle through priority ties); the
        // row first snapped back to its old slot. The reorder must instead be
        // reflected in ONE atomic optimistic update on drop.
        let resolveFirstPatch: (() => void) | undefined;
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3
            .mockImplementationOnce(
                () => new Promise((resolve) => {
                    resolveFirstPatch = () => resolve(createAuthoritativeGroup({ generation: 3 }));
                }),
            )
            .mockImplementation(async () => createAuthoritativeGroup({ generation: 4 }));

        const screen = await renderPoolDetail();
        // Initial fallback order is [work, backup] (priorities 100, 200).
        expect(findMemberBlocks(screen).map((block) => block.profileId)).toEqual(['work', 'backup']);

        const gesture = getMemberReorderGesture(screen, 'backup');
        await act(async () => {
            gesture.__handlers.onStart?.({});
            gesture.__handlers.onUpdate?.({ translationY: -60 });
            gesture.__handlers.onEnd?.({});
            await flushAsyncHandlers();
        });

        // The dropped order is reflected immediately even though the first patch is
        // still pending — no snap-back, no per-patch reshuffle.
        expect(findMemberBlocks(screen).map((block) => block.profileId)).toEqual(['backup', 'work']);

        // Let the held patch settle so the commit completes cleanly.
        await act(async () => {
            resolveFirstPatch?.();
            await flushAsyncHandlers();
            await flushAsyncHandlers();
        });
    });

    it('omits the drag gesture for a single-member pool (nothing to reorder)', async () => {
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            members: [createAuthoritativeGroup().members[0]],
        })];

        const screen = await renderPoolDetail();
        const block = findMemberBlocks(screen).find((candidate) => candidate.profileId === 'work');
        expect(block).toBeTruthy();
        expect(block?.reorderGesture == null).toBe(true);
    });

    it('disables Move up on the first member and Move down on the last member', async () => {
        const screen = await renderPoolDetail();
        const blocks = findMemberBlocks(screen);
        const work = blocks.find((block) => block.profileId === 'work');
        const backup = blocks.find((block) => block.profileId === 'backup');

        expect(work?.actions?.find((action) => action.id.endsWith(':move-up'))?.disabled).toBe(true);
        expect(work?.actions?.find((action) => action.id.endsWith(':move-down'))?.disabled).toBe(false);
        expect(backup?.actions?.find((action) => action.id.endsWith(':move-down'))?.disabled).toBe(true);
    });

    it('refetches the group and retries the reorder on a generation conflict', async () => {
        authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3
            .mockRejectedValueOnce(createStructuredConnectedServiceError('connect_group_generation_conflict', { status: 409 }))
            .mockImplementation(async () => createAuthoritativeGroup({ generation: 7 }));
        // After the conflict, the refetch returns a fresh group at a new generation.
        authGroupApiSpies.listConnectedServiceAuthGroupsV3
            .mockImplementationOnce(async () => authoritativeGroupState.groups)
            .mockImplementation(async () => [createAuthoritativeGroup({ generation: 5 })]);

        const screen = await renderPoolDetail();
        const backupBlock = findMemberBlocks(screen).find((block) => block.profileId === 'backup');

        await act(async () => {
            backupBlock?.actions?.find((action) => action.id.endsWith(':move-up'))?.onPress?.();
            await flushAsyncHandlers();
        });

        // The retried patch threads the refetched generation (5).
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupMemberV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                profileId: 'backup',
                patch: { priority: 100, expectedGeneration: 5 },
            },
        );
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('offers expiry-first only on supporting servers and saves the explicit choice', async () => {
        const screen = await renderPoolDetail();
        const dropdown = findDropdown(screen, 'connected-services-pool-detail:strategy');
        if (!dropdown) throw new Error('Strategy control is missing');
        expect(dropdown.props.items.map((item: { id: string }) => item.id)).toContain('expiry_first');
        await act(async () => {
            dropdown.props.onSelect('expiry_first');
            await flushAsyncHandlers();
        });
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.anything(), expect.objectContaining({ patch: expect.objectContaining({ policy: { strategy: 'expiry_first' } }) }),
        );
        featureEnabledById.set('connectedServices.poolExpiryFirst', false);
        const unsupported = await renderPoolDetail();
        const unsupportedDropdown = findDropdown(unsupported, 'connected-services-pool-detail:strategy');
        if (!unsupportedDropdown) throw new Error('Strategy control is missing');
        expect(unsupportedDropdown.props.items.map((item: { id: string }) => item.id))
            .not.toContain('expiry_first');
    });

    it('surfaces every Behavior control including the two previously-hidden knobs', async () => {
        const screen = await renderPoolDetail();
        await expandAdvanced(screen);

        // Carried-over controls (top-level + Advanced).
        expect(screen.findByTestId('connected-services-pool-detail:auto-switch')).toBeTruthy();
        expect(findDropdown(screen, 'connected-services-pool-detail:strategy')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:soft-switch-threshold')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:stale-probe-after')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-budget')).toBeTruthy();
        expect(findDropdown(screen, 'connected-services-pool-detail:recovery-mode')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:recovery-prompt')).toBeTruthy();

        // The two newly-surfaced knobs.
        expect(screen.findByTestId('connected-services-pool-detail:claude-auto-continue:toggle')).toBeNull();
        expect(screen.findByTestId('connected-services-pool-detail:auto-restore-primary')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-on:usageLimit')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-on:authExpired')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-on:accountChanged')).toBeTruthy();
        expect(screen.findByTestId('connected-services-pool-detail:switch-on:refreshFailure')).toBeTruthy();
    });

    it('offers quota-reset spending only with server support and persists the explicit opt-in', async () => {
        featureEnabledById.set('connectedServices.autoQuotaReset', true);
        const screen = await renderPoolDetail();
        const toggle = screen.findByTestId('connected-services-pool-detail:auto-quota-reset:toggle');
        expect(toggle).toBeTruthy();
        expect(toggle?.props.value).toBe(false);
        await act(async () => {
            toggle?.props.onValueChange(true);
            await flushAsyncHandlers();
        });
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', patch: { policy: { autoUseQuotaResetsWhenExhausted: true }, expectedGeneration: 2 } },
        );
    });

    it('does not offer quota-reset spending against an older server', async () => {
        featureEnabledById.set('connectedServices.autoQuotaReset', false);
        const screen = await renderPoolDetail();
        expect(screen.findByTestId('connected-services-pool-detail:auto-quota-reset:toggle')).toBeNull();
    });

    it('authors a selected provider allowance only when the server advertises pool quota selection', async () => {
        featureEnabledById.set('connectedServices.poolQuotaLimitSelection', true);
        const screen = await renderPoolDetail();
        const dropdown = findQuotaLimitsDropdown(screen);
        expect(dropdown).toBeTruthy();

        await act(async () => {
            dropdown?.props.onOpenChange?.(true);
            await flushAsyncHandlers();
        });
        await act(async () => {
            findQuotaLimitsDropdown(screen)?.props.onSelect?.('standard');
            await flushAsyncHandlers();
        });
        await act(async () => {
            findQuotaLimitsDropdown(screen)?.props.onOpenChange?.(false);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                patch: {
                    policy: { quotaLimitSelection: { mode: 'selected', providerLimitIds: ['standard'] } },
                    expectedGeneration: 2,
                },
            },
        );
    });

    it('marks all-limit evidence as partial while pool account quotas are still loading', async () => {
        featureEnabledById.set('connectedServices.poolQuotaLimitSelection', true);
        quotaSnapshotsState.loadingByKey = { 'openai-codex/backup': true };

        const screen = await renderPoolDetail();

        expect(textSpies.translate).toHaveBeenCalledWith(
            'connectedServices.pools.detail.quotaLimitsRefreshing',
            { count: 1 },
        );
        expect(findQuotaLimitsDropdown(screen)?.props.items[0]).toEqual(expect.objectContaining({
            id: ' ',
            subtitle: expect.any(String),
        }));
    });

    it('builds quota-limit choices only from enabled pool members', async () => {
        const base = createAuthoritativeGroup();
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            members: base.members.map((member) => member.profileId === 'backup'
                ? { ...member, enabled: false }
                : member),
        })];

        await renderPoolDetail();

        expect(quotaSnapshotsState.requestedProfiles).toEqual([expect.objectContaining({
            serviceId: 'openai-codex',
            profileId: 'work',
        })]);
    });

    it('hides provider allowance selection against an older server', async () => {
        featureEnabledById.set('connectedServices.poolQuotaLimitSelection', false);
        const screen = await renderPoolDetail();
        expect(findQuotaLimitsDropdown(screen)).toBeUndefined();
    });

    it('does not turn deselecting the final custom allowance into an implicit all-limits policy', async () => {
        featureEnabledById.set('connectedServices.poolQuotaLimitSelection', true);
        const base = createAuthoritativeGroup();
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            policy: {
                ...base.policy,
                quotaLimitSelection: { mode: 'selected', providerLimitIds: ['standard'] },
            },
        })];
        const screen = await renderPoolDetail();

        await act(async () => {
            findQuotaLimitsDropdown(screen)?.props.onOpenChange?.(true);
            await flushAsyncHandlers();
        });
        await act(async () => {
            findQuotaLimitsDropdown(screen)?.props.onSelect?.('standard');
            await flushAsyncHandlers();
        });
        await act(async () => {
            findQuotaLimitsDropdown(screen)?.props.onOpenChange?.(false);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).not.toHaveBeenCalled();
    });

    it('offers an explicit return from a custom allowance selection to all limits', async () => {
        featureEnabledById.set('connectedServices.poolQuotaLimitSelection', true);
        const base = createAuthoritativeGroup();
        authoritativeGroupState.groups = [createAuthoritativeGroup({
            policy: {
                ...base.policy,
                quotaLimitSelection: { mode: 'selected', providerLimitIds: ['standard'] },
            },
        })];
        const screen = await renderPoolDetail();

        await act(async () => {
            findQuotaLimitsDropdown(screen)?.props.onOpenChange?.(true);
            await flushAsyncHandlers();
        });
        await act(async () => {
            findQuotaLimitsDropdown(screen)?.props.onSelect?.(' ');
            await flushAsyncHandlers();
        });
        await act(async () => {
            findQuotaLimitsDropdown(screen)?.props.onOpenChange?.(false);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                patch: {
                    policy: { quotaLimitSelection: { mode: 'all', providerLimitIds: [] } },
                    expectedGeneration: 2,
                },
            },
        );
    });

    it('offers automatic disable for model-entitlement failures only with server support', async () => {
        featureEnabledById.set('connectedServices.autoDisablePlanInvalid', true);
        const screen = await renderPoolDetail();
        const toggle = screen.findByTestId('connected-services-pool-detail:auto-disable-plan-invalid:toggle');
        expect(toggle).toBeTruthy();
        expect(toggle?.props.value).toBe(false);
        await act(async () => {
            toggle?.props.onValueChange(true);
            await flushAsyncHandlers();
        });
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary', patch: { policy: { autoDisablePlanInvalidAccounts: true }, expectedGeneration: 2 } },
        );
    });

    it('does not offer automatic plan-invalid disable against an older server', async () => {
        featureEnabledById.set('connectedServices.autoDisablePlanInvalid', false);
        const screen = await renderPoolDetail();
        expect(screen.findByTestId('connected-services-pool-detail:auto-disable-plan-invalid:toggle')).toBeNull();
    });

    it('does not offer quota-reset spending for a provider without banked resets', async () => {
        featureEnabledById.set('connectedServices.autoQuotaReset', true);
        connectedServicesModuleState.searchParams = { serviceId: 'anthropic', groupId: 'primary' };
        authoritativeGroupState.groups = [createAuthoritativeGroup({ serviceId: 'anthropic' })];
        const screen = await renderPoolDetail();
        expect(screen.findByTestId('connected-services-pool-detail:auto-quota-reset:toggle')).toBeNull();
    });

    it('patches autoRestorePrimaryWhenReset through the group policy patch API', async () => {
        const screen = await renderPoolDetail();
        await expandAdvanced(screen);

        await act(async () => {
            screen.findByTestId('connected-services-pool-detail:auto-restore-primary:toggle')?.props.onValueChange?.(true);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                patch: { policy: { autoRestorePrimaryWhenReset: true }, expectedGeneration: 2 },
            },
        );
    });

    it('patches a switchOn.* trigger through the group policy patch API, preserving the other flags', async () => {
        const screen = await renderPoolDetail();
        await expandAdvanced(screen);

        await act(async () => {
            screen.findByTestId('connected-services-pool-detail:switch-on:refreshFailure:toggle')?.props.onValueChange?.(true);
            await flushAsyncHandlers();
        });

        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            {
                serviceId: 'openai-codex',
                groupId: 'primary',
                patch: {
                    policy: {
                        switchOn: {
                            usageLimit: true,
                            authExpired: true,
                            accountChanged: true,
                            refreshFailure: true,
                        },
                    },
                    expectedGeneration: 2,
                },
            },
        );
    });

    it('deletes the pool after confirmation (danger action)', async () => {
        modalSpies.confirm.mockResolvedValueOnce(true);
        const screen = await renderPoolDetail();

        await screen.pressByTestIdAsync('connected-services-pool-detail:delete');

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.deleteConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', groupId: 'primary' },
        );
    });

    it('skips delete when the danger confirmation is cancelled', async () => {
        modalSpies.confirm.mockResolvedValueOnce(false);
        const screen = await renderPoolDetail();

        await screen.pressByTestIdAsync('connected-services-pool-detail:delete');

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(authGroupApiSpies.deleteConnectedServiceAuthGroupV3).not.toHaveBeenCalled();
    });

    it('disables fallback Behavior controls when account fallback is unsupported by the runtime', async () => {
        connectedServicesModuleState.searchParams = { serviceId: 'github', groupId: 'primary' };
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
        authoritativeGroupState.groups = [createAuthoritativeGroup({ serviceId: 'github' })];

        const screen = await renderPoolDetail();

        const autoSwitch = screen.tree.root.find((node) =>
            node.props?.testID === 'connected-services-pool-detail:auto-switch');
        expect(autoSwitch.props.disabled).toBe(true);

        const autoSwitchToggle = screen.findByTestId('connected-services-pool-detail:auto-switch:toggle');
        await act(async () => {
            autoSwitchToggle?.props.onValueChange?.(true);
            await flushAsyncHandlers();
        });
        expect(authGroupApiSpies.patchConnectedServiceAuthGroupV3).not.toHaveBeenCalled();
    });

    it('fails closed and shows the disabled message when account groups are disabled', async () => {
        featureEnabledById.set('connectedServices.accountGroups', false);

        const screen = await renderPoolDetail();

        expect(screen.findAllByType('AccountBlock' as never).length).toBe(0);
        expect(screen.getTextContent()).toContain('settings.connectedAccountsDisabled');
    });
});
