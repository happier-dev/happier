import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';

import { renderScreen } from '@/dev/testkit';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import {
    ConnectedServiceAuthGroupPolicyV1Schema,
    type ConnectedServiceAuthGroupPolicyV1,
    type ConnectedServiceQuotaSnapshotV1,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import type { PoolMemberRow } from './PoolMemberRow';
import { EntityFlatReorderList } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { storage } from '@/sync/domains/state/storageStore';
import {
    buildPoolQuotaLimitCandidates,
    QualifiedPoolDetailView,
    type PoolMemberQuota,
    type QualifiedPoolDetailAccount,
    type QualifiedPoolDetailMutations,
} from './QualifiedPoolDetailView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let restorePopoverGlobals: (() => void) | undefined;
const initialScope = storage.getState().profileScope;
beforeEach(() => { restorePopoverGlobals = withPopoverWebGlobals(); });
afterEach(async () => {
    await act(async () => storage.setState({ profileScope: initialScope }));
    restorePopoverGlobals?.();
});

const modalSpies = vi.hoisted(() => ({
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: modalSpies.prompt as never,
            confirm: modalSpies.confirm as never,
            alert: modalSpies.alert as never,
        },
    }).module;
});

// Icons render a native glyph package; the view's behaviour never depends on it.
vi.mock('@/components/ui/icons/Icon', () => ({
    ICON_SIZE: { sm: 16, md: 20, lg: 24 },
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));


const SERVICE = { pluginId: 'acme.accounts', localId: 'openai-codex' } as const;

function accountRef(accountId: string): QualifiedConnectedAccountRef {
    return { service: { ...SERVICE }, accountId };
}

function policy(
    overrides: Partial<ConnectedServiceAuthGroupPolicyV1> = {},
): ConnectedServiceAuthGroupPolicyV1 {
    return { ...ConnectedServiceAuthGroupPolicyV1Schema.parse({}), ...overrides };
}

/** Members intentionally out of priority order so ordering is proven, not luck. */
function createGroup(
    overrides: Partial<QualifiedConnectedAccountUiGroup> = {},
): QualifiedConnectedAccountUiGroup {
    return {
        ref: { service: { ...SERVICE }, groupId: 'primary' },
        displayName: 'Team pool',
        policy: policy(),
        activeAccountId: 'work',
        revision: {
            protocol: 'v4',
            incarnation: 'qualified-group-row-primary',
            generation: 2,
            runtimeStateRevision: 1,
        },
        state: { status: 'ready' },
        members: [
            { ref: accountRef('backup'), priority: 200, enabled: true, state: {} },
            { ref: accountRef('work'), priority: 100, enabled: true, state: {} },
        ],
        ...overrides,
    };
}

const ACCOUNTS: ReadonlyArray<QualifiedPoolDetailAccount> = [
    {
        ref: accountRef('work'),
        displayName: 'Work workspace',
        providerIdentity: { email: 'work@example.com' },
        status: 'connected',
    },
    { ref: accountRef('backup'), displayName: 'backup@example.com', status: 'connected' },
    { ref: accountRef('spare'), displayName: 'spare@example.com', status: 'connected' },
];

type PatchMemberInput = Parameters<QualifiedPoolDetailMutations['patchMember']>[0];

const mutationResults = {
    patchMember: [] as QualifiedConnectedAccountUiGroup[],
    addMember: [] as QualifiedConnectedAccountUiGroup[],
    removeMember: [] as QualifiedConnectedAccountUiGroup[],
};

const patch = vi.fn<QualifiedPoolDetailMutations['patch']>();
const patchMember = vi.fn<QualifiedPoolDetailMutations['patchMember']>();
const addMember = vi.fn<QualifiedPoolDetailMutations['addMember']>();
const removeMember = vi.fn<QualifiedPoolDetailMutations['removeMember']>();
const setActiveAccount = vi.fn<QualifiedPoolDetailMutations['setActiveAccount']>();
const deleteGroup = vi.fn<QualifiedPoolDetailMutations['delete']>();

function createMutations(): QualifiedPoolDetailMutations {
    return {
        mutating: false,
        patch,
        patchMember,
        addMember,
        removeMember,
        setActiveAccount,
        delete: deleteGroup,
    };
}

async function flush(times = 8): Promise<void> {
    for (let index = 0; index < times; index += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

type ViewOverrides = Partial<Omit<React.ComponentProps<typeof QualifiedPoolDetailView>, 'group' | 'mutations'>>;

async function renderPoolDetail(
    overrides: Partial<QualifiedConnectedAccountUiGroup> = {},
    viewOverrides: ViewOverrides = {},
) {
    const group = createGroup(overrides);
    const screen = await renderScreen(
        <QualifiedPoolDetailView
            accounts={ACCOUNTS}
            serviceLabel="Codex"
            now={NOW}
            {...viewOverrides}
            group={group}
            mutations={createMutations()}
        />,
    );
    await flush(2);
    return { screen, group };
}

it('keeps an empty pool focused on adding its first members rather than unusable policy controls', async () => {
    const { screen } = await renderPoolDetail({ members: [], activeAccountId: null });
    expect(screen.findByTestId('connected-services-pool-detail:no-members')).not.toBeNull();
    expect(screen.findByTestId('connected-services-pool-detail:auto-switch:toggle')).toBeNull();
    expect(screen.findByTestId('connected-services-pool-detail:strategy')).toBeNull();
});
it('keeps individual member limits instead of repeating the pool aggregate on a compact pane', async () => {
    const { screen } = await renderPoolDetail();
    const pane = screen.findHostByTestId('connected-services-pool-detail');
    act(() => pane?.props.onLayout?.({ nativeEvent: { layout: { width: 390, height: 800, x: 0, y: 0 } } }));
    expect(screen.findByTestId('connected-services-pool-detail:left:none') === null).toBe(true);
    expect(memberRows(screen)).toHaveLength(2);
});
it('keeps compact defaults in the identity line and retains sharing without desktop header controls', async () => {
    const setDefault = vi.fn();
    const share = vi.fn();
    const { screen } = await renderPoolDetail({}, { agentDefaults: { choices: [{ agentId: 'codex', title: 'Codex', isDefault: true }], setDefault }, onShareWithTeam: share });
    act(() => screen.findHostByTestId('connected-services-pool-detail')?.props.onLayout?.({ nativeEvent: { layout: { width: 390, height: 800, x: 0, y: 0 } } }));
    expect(screen.findHostByTestId('connected-services-pool-detail:more')).toBeNull();
    await screen.pressByTestIdAsync('connected-services-pool-detail:default-for');
    await screen.pressByTestIdAsync('connected-services-pool-detail:default-for:agent:codex');
    expect(setDefault).toHaveBeenCalledWith('codex', false);
    await screen.pressByTestIdAsync('connected-services-pool-detail:share');
    expect(share).toHaveBeenCalledOnce();
});

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function snapshot(profileId: string, meters: ReadonlyArray<Readonly<{ id: string; label: string; left: number; resetsInMs: number }>>, extra: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
    return {
        v: 1,
        serviceId: 'openai-codex',
        profileId,
        fetchedAt: NOW - MIN,
        staleAfterMs: 15 * MIN,
        planLabel: 'Pro',
        accountLabel: null,
        meters: meters.map((meter) => ({
            meterId: meter.id,
            label: meter.label,
            used: null,
            limit: null,
            remainingPct: meter.left,
            unit: 'percent',
            utilizationPct: 100 - meter.left,
            resetsAt: NOW + meter.resetsInMs,
            status: 'ok',
            details: {},
        })),
        ...extra,
    } as ConnectedServiceQuotaSnapshotV1;
}

function quota(entries: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>): Record<string, PoolMemberQuota> {
    return Object.fromEntries(Object.entries(entries).map(([accountId, value]) => [accountId, { snapshot: value, loading: false }]));
}

type Screen = Awaited<ReturnType<typeof renderPoolDetail>>['screen'];
type MemberRowProps = React.ComponentProps<typeof PoolMemberRow>;

function memberRows(screen: Screen): MemberRowProps[] {
    // The row's own element: the one carrying its actions and usage (the Item below reuses its testID).
    return screen.root
        .findAll((node) => /^connected-services-pool-detail:member:[^:]+$/.test(String(node.props?.testID ?? ''))
            && Array.isArray(node.props?.actions) && node.props?.usage !== undefined)
        .map((node) => node.props as MemberRowProps);
}

function memberRow(screen: Screen, accountId: string): MemberRowProps {
    const row = memberRows(screen).find((candidate) => candidate.testID.endsWith(`:member:${accountId}`));
    if (!row) throw new Error(`no member row for "${accountId}"`);
    return row;
}

function memberAction(screen: Screen, accountId: string, suffix: string) {
    const action = memberRow(screen, accountId).actions.find((candidate) => candidate.id.endsWith(`:${suffix}`));
    if (!action) throw new Error(`no "${suffix}" action for "${accountId}"`);
    return action;
}

function itemProps(screen: Screen, testID: string): Record<string, any> {
    const node = screen.root.findAll((candidate) => candidate.props?.testID === testID && candidate.props?.title !== undefined)[0];
    if (!node) throw new Error(`no item "${testID}"`);
    return node.props;
}

function dropdownByTriggerTestId(screen: Screen, testID: string): ReactTestInstance {
    const node = screen.root
        .findAll((candidate) => typeof candidate.type !== 'string' && Array.isArray(candidate.props.items) && typeof candidate.props.onSelect === 'function')
        .find((candidate) => candidate.props.itemTrigger?.itemProps?.testID === testID);
    if (!node) throw new Error(`no dropdown with trigger testID "${testID}"`);
    return node;
}

/** The membership multi-select is the only menu that stays open across selections. */
function membersDropdown(screen: Screen): ReactTestInstance {
    const node = screen.root
        .findAll((candidate) => typeof candidate.type !== 'string' && Array.isArray(candidate.props.items) && typeof candidate.props.onSelect === 'function')
        .find((candidate) => candidate.props.closeOnSelect === false);
    if (!node) throw new Error('no members multi-select dropdown');
    return node;
}

function switchByTestId(screen: Screen, testID: string): ReactTestInstance {
    const node = screen.root
        .findAll((candidate) => typeof candidate.type !== 'string' && typeof candidate.props.value === 'boolean')
        .find((candidate) => candidate.props.testID === testID);
    if (!node) throw new Error(`no switch with testID "${testID}"`);
    return node;
}

async function press(target: { onPress?: () => void } | null | undefined): Promise<void> {
    await act(async () => {
        target?.onPress?.();
    });
    await flush();
}

async function pressRow(screen: Screen, testID: string): Promise<void> {
    await act(async () => {
        screen.pressByTestId(testID);
    });
    await flush();
}


beforeEach(() => {
    modalSpies.prompt.mockReset();
    modalSpies.confirm.mockReset();
    modalSpies.alert.mockReset();
    modalSpies.prompt.mockResolvedValue(null);
    modalSpies.confirm.mockResolvedValue(false);
    modalSpies.alert.mockResolvedValue(undefined);
    mutationResults.patchMember = [];
    mutationResults.addMember = [];
    mutationResults.removeMember = [];
    patch.mockReset();
    patch.mockImplementation(async ({ group, displayName, policy: policyPatch }) => ({
        ...group,
        ...(displayName === undefined ? null : { displayName }),
        ...(policyPatch ? { policy: { ...group.policy, ...policyPatch } } : null),
    }));
    patchMember.mockReset();
    patchMember.mockImplementation(async ({ group, account, enabled, priority }: PatchMemberInput) => {
        const next: QualifiedConnectedAccountUiGroup = {
            ...group,
            members: group.members.map((member) => (
                member.ref.accountId === account.accountId
                    ? {
                        ...member,
                        ...(enabled === undefined ? null : { enabled }),
                        ...(priority === undefined ? null : { priority }),
                    }
                    : member
            )),
        };
        mutationResults.patchMember.push(next);
        return next;
    });
    addMember.mockReset();
    addMember.mockImplementation(async ({ group, account }) => {
        const next: QualifiedConnectedAccountUiGroup = {
            ...group,
            members: [
                ...group.members,
                { ref: account, priority: (group.members.length + 1) * 100, enabled: true, state: {} },
            ],
        };
        mutationResults.addMember.push(next);
        return next;
    });
    removeMember.mockReset();
    removeMember.mockImplementation(async ({ group, account }) => {
        const next: QualifiedConnectedAccountUiGroup = {
            ...group,
            members: group.members.filter((member) => member.ref.accountId !== account.accountId),
        };
        mutationResults.removeMember.push(next);
        return next;
    });
    setActiveAccount.mockReset();
    setActiveAccount.mockImplementation(async ({ group, account }) => ({
        ...group,
        activeAccountId: account.accountId,
    }));
    deleteGroup.mockReset();
    deleteGroup.mockResolvedValue(true);
});

describe('QualifiedPoolDetailView', () => {
    it('keeps provider allowance names, deduplicates windows, and reports enabled-member coverage', () => {
        const candidates = buildPoolQuotaLimitCandidates({
            enabledMemberCount: 3,
            selectedProviderLimitIds: ['iguana_necktie', 'saved-but-unreported', 'seven_day_all'],
            snapshots: [
                {
                    v: 1,
                    serviceId: 'openai-codex',
                    profileId: 'work',
                    fetchedAt: 1_000,
                    staleAfterMs: 60_000,
                    planLabel: null,
                    accountLabel: null,
                    meters: [
                        {
                            meterId: 'spark:primary', label: 'Spark · Primary', providerLimitId: 'spark', modelId: 'gpt-spark',
                            windowDurationMs: 5 * 60 * 60_000,
                            used: null, limit: null, unit: 'unknown', utilizationPct: 10, resetsAt: null, status: 'ok', details: {},
                        },
                        {
                            meterId: 'spark:secondary', label: 'Spark · Secondary', providerLimitId: 'spark', modelId: 'gpt-spark',
                            windowDurationMs: 7 * 24 * 60 * 60_000,
                            used: null, limit: null, unit: 'unknown', utilizationPct: 20, resetsAt: null, status: 'ok', details: {},
                        },
                        {
                            meterId: 'seven_day_fable', label: 'seven_day_fable', providerLimitId: 'seven_day_fable', modelId: null,
                            used: null, limit: null, unit: 'unknown', utilizationPct: 30, resetsAt: null, status: 'ok', details: { rawScope: 'weekly_scoped' },
                        },
                        {
                            meterId: 'iguana_necktie', label: 'Unknown', providerLimitId: 'iguana_necktie', modelId: null,
                            used: null, limit: null, unit: 'unknown', utilizationPct: 40, resetsAt: null, status: 'ok', details: {},
                        },
                        {
                            meterId: 'legacy-session', label: 'Legacy session', modelId: null,
                            used: null, limit: null, unit: 'unknown', utilizationPct: 50, resetsAt: null, status: 'ok', details: {},
                        },
                    ],
                },
                {
                    v: 1,
                    serviceId: 'openai-codex',
                    profileId: 'backup',
                    fetchedAt: 1_000,
                    staleAfterMs: 60_000,
                    planLabel: null,
                    accountLabel: null,
                    meters: [{
                        meterId: 'spark:primary', label: 'Spark · Primary', providerLimitId: 'spark', modelId: 'gpt-spark',
                        windowDurationMs: 5 * 60 * 60_000,
                        used: null, limit: null, unit: 'unknown', utilizationPct: 15, resetsAt: null, status: 'ok', details: {},
                    }],
                },
            ],
        });

        expect(candidates).toEqual(expect.arrayContaining([
            expect.objectContaining({
                providerLimitId: 'spark',
                title: 'Spark',
                modelIds: ['gpt-spark'],
                windowCount: 2,
                windowSummary: '5h + 7d',
                reportingMemberCount: 2,
                enabledMemberCount: 3,
            }),
            expect.objectContaining({
                providerLimitId: 'seven_day_fable',
                title: 'Weekly (Fable)',
                windowCount: 1,
                reportingMemberCount: 1,
            }),
            expect.objectContaining({
                providerLimitId: 'iguana_necktie',
                title: 'connectedServices.detail.groupDetail.quotaLimitProviderAllowanceTitle',
                technicalId: 'iguana_necktie',
            }),
            expect.objectContaining({
                providerLimitId: 'saved-but-unreported',
                technicalId: 'saved-but-unreported',
                unavailable: true,
                reportingMemberCount: 0,
            }),
            expect.objectContaining({ providerLimitId: 'seven_day_all', title: 'Weekly (all models)', unavailable: true }),
            expect.objectContaining({
                providerLimitId: 'legacy-session',
                title: 'Legacy session',
                reportingMemberCount: 1,
            }),
        ]));
        expect(candidates.filter((candidate) => candidate.providerLimitId === 'spark')).toHaveLength(1);
    });

    it('authors one nonempty custom quota-family selection and preserves unavailable saved limits', async () => {
        const { screen } = await renderPoolDetail({
            policy: policy({ quotaLimitSelection: { mode: 'selected', providerLimitIds: ['legacy-limit'] } }),
        }, {
            quotaLimitSelectionEnabled: true,
            memberQuotaByAccountId: quota({
                work: {
                    ...snapshot('work', []),
                    meters: [{
                        meterId: 'spark:primary', label: 'Spark · Primary', providerLimitId: 'spark',
                        used: null, limit: null, unit: 'unknown', utilizationPct: 10, resetsAt: null, status: 'ok', details: {},
                    }],
                } as ConnectedServiceQuotaSnapshotV1,
            }),
        });
        const menu = quotaLimitsMenu(screen);
        expect(menu?.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'spark', title: 'Spark' }),
            expect.objectContaining({
                id: 'legacy-limit',
                subtitle: expect.stringMatching(/quotaLimitUnavailableSubtitle.*quotaLimitTechnicalIdSubtitle/),
            }),
        ]));

        await act(async () => menu?.props.onOpenChange(true));
        await act(async () => quotaLimitsMenu(screen)?.props.onSelect('legacy-limit'));
        await act(async () => quotaLimitsMenu(screen)?.props.onOpenChange(false));
        expect(patch).not.toHaveBeenCalled();

        await act(async () => quotaLimitsMenu(screen)?.props.onOpenChange(true));
        await act(async () => quotaLimitsMenu(screen)?.props.onSelect('spark'));
        await act(async () => quotaLimitsMenu(screen)?.props.onOpenChange(false));
        expect(patch).toHaveBeenCalledWith(expect.objectContaining({
            policy: expect.objectContaining({
                quotaLimitSelection: { mode: 'selected', providerLimitIds: ['legacy-limit', 'spark'] },
            }),
        }));
    });

    it('does not expose quota policy authoring when the negotiated feature is absent', async () => {
        const { screen } = await renderPoolDetail();
        expect(quotaLimitsMenu(screen)).toBeUndefined();
    });

    it('marks the reported-limit inventory incomplete while enabled member quotas load', async () => {
        const { screen } = await renderPoolDetail({}, {
            quotaLimitSelectionEnabled: true,
            memberQuotaByAccountId: { work: { snapshot: null, loading: true }, backup: { snapshot: null, loading: false } },
        });
        expect(quotaLimitsMenu(screen)?.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: ' ', subtitle: expect.stringContaining('quotaLimitsAllLoadingSubtitle') }),
        ]));
    });

    it('offers the current Pool to a Team from the pool menu', async () => {
        const onShareWithTeam = vi.fn();
        const { screen } = await renderPoolDetail({}, { onShareWithTeam });
        await act(async () => { moreMenu(screen).props.onSelect('share'); });
        expect(onShareWithTeam).toHaveBeenCalledTimes(1);

        const withoutTeams = await renderPoolDetail();
        expect(moreMenu(withoutTeams.screen).props.items.map((item: { id: string }) => item.id)).not.toContain('share');
    });

    it('offers explicit quota-reset spending only when the owning service and server support it', async () => {
        const { screen } = await renderPoolDetail({}, { autoQuotaResetEnabled: true });
        const toggle = screen.findByTestId('connected-services-pool-detail:auto-quota-reset:toggle');
        expect(toggle?.props.value).toBe(false);
        await act(async () => { await toggle?.props.onValueChange(true); });
        expect(patch).toHaveBeenCalledWith(expect.objectContaining({
            policy: expect.objectContaining({ autoUseQuotaResetsWhenExhausted: true }),
        }));
        const absent = await renderPoolDetail();
        expect(absent.screen.findByTestId('connected-services-pool-detail:auto-quota-reset:toggle')).toBeNull();
    });

    it('offers opt-in model-entitlement auto-disable only when the server enables it', async () => {
        const { screen } = await renderPoolDetail({}, { autoDisablePlanInvalidEnabled: true });
        const toggle = screen.findByTestId('connected-services-pool-detail:auto-disable-plan-invalid:toggle');
        expect(toggle?.props.value).toBe(false);
        await act(async () => { await toggle?.props.onValueChange(true); });
        expect(patch).toHaveBeenCalledWith(expect.objectContaining({
            policy: expect.objectContaining({ autoDisablePlanInvalidAccounts: true }),
        }));
        const unavailable = await renderPoolDetail();
        expect(unavailable.screen.findByTestId('connected-services-pool-detail:auto-disable-plan-invalid:toggle')).toBeNull();
    });

    it('lists members in priority order with the active one marked and reorder live', async () => {
        const { screen } = await renderPoolDetail();
        expect(memberRows(screen).map((row) => row.testID)).toEqual([
            'connected-services-pool-detail:member:work',
            'connected-services-pool-detail:member:backup',
        ]);
        expect(memberRow(screen, 'work').active).toBe(true);
        expect(memberRow(screen, 'backup').active).toBe(false);
        expect(screen.root.findByType(EntityFlatReorderList).props.binding.items.map((item: { id: string }) => item.id)).toEqual(['work', 'backup']);
    });

    it('says why the pool turned a member off, and that an off member is not used', async () => {
        const { screen } = await renderPoolDetail({
            members: [
                { ref: accountRef('work'), priority: 100, enabled: true, state: {} },
                { ref: accountRef('backup'), priority: 200, enabled: false, state: { autoDisabledReason: 'model_not_entitled' } },
            ],
        });
        expect(memberRow(screen, 'backup').note).toEqual({ icon: 'info', text: 'connectedServicesPool.autoOffModel' });
        expect(memberRow(screen, 'backup').usage).toEqual({ kind: 'off' });
    });

    it('names a member once: by its label, else its email, never the raw account id', async () => {
        const { screen } = await renderPoolDetail({}, {
            memberQuotaByAccountId: quota({ work: snapshot('work', [{ id: '5h', label: '5-hour', left: 40, resetsInMs: 60 * MIN }]) }),
        });
        // No user label: the email names the account and is not repeated on the identity line.
        expect(memberRow(screen, 'work').title).toBe('work@example.com');
        expect(memberRow(screen, 'work').identityLabel).toBe('Pro');

        const labelled = await renderPoolDetail({}, { accountLabels: { work: 'Primary' } });
        expect(memberRow(labelled.screen, 'work').title).toBe('Primary');
        expect(memberRow(labelled.screen, 'work').identityLabel).toBe('work@example.com');

        const unnamed = await renderPoolDetail({}, {
            accounts: [
                { ref: accountRef('work'), providerIdentity: { email: 'work@example.com' }, status: 'connected' },
                { ref: accountRef('backup'), status: 'connected' },
            ],
        });
        expect(memberRow(unnamed.screen, 'backup').title).toBe('Codex');
        expect(memberRow(unnamed.screen, 'backup').identityLabel ?? '').not.toContain('backup');
    });

    it('hides provider id fallback names across members, choices and Now while retaining user names', async () => {
        const { screen } = await renderPoolDetail({}, {
            accounts: [
                { ref: accountRef('work'), providerIdentity: { accountId: 'provider-account-42' } },
                { ref: accountRef('backup'), providerIdentity: { accountId: 'provider-account-43' } },
            ],
            accountLabels: { backup: 'provider-account-43' },
            presentIdentity: (input) => presentConnectedAccountIdentity({
                ...input, hidden: true, label: input.label ?? null,
                email: input.email ?? null, accountId: input.accountId ?? null,
            }),
        });
        expect(memberRow(screen, 'work').title).toBe('provi•••42');
        expect(memberRow(screen, 'backup').title).toBe('provider-account-43');
        expect(membersDropdown(screen).props.items[0]).toMatchObject({ title: 'provi•••42' });
        expect(itemProps(screen, 'connected-services-pool-detail:now').title).toBe('connectedServicesPool.using(name=provi•••42)');
        expect(screen.getTextContent()).not.toContain('provider-account-42');
    });

    it('averages what is left across the members that are on, with who has room and who is not reported', async () => {
        const { screen } = await renderPoolDetail({
            members: [
                { ref: accountRef('work'), priority: 100, enabled: true, state: {} },
                { ref: accountRef('backup'), priority: 200, enabled: true, state: {} },
                { ref: accountRef('spare'), priority: 300, enabled: true, state: {} },
            ],
        }, {
            memberQuotaByAccountId: quota({
                work: snapshot('work', [{ id: '5h', label: '5-hour', left: 40, resetsInMs: 90 * MIN }]),
                backup: snapshot('backup', [{ id: '5h', label: '5-hour', left: 0, resetsInMs: 30 * MIN }]),
                spare: null,
            }),
        });
        const meter = screen.root.findAll((node) => node.props?.testID === 'connected-services-pool-detail:left:5h' && node.props?.remainingPct !== undefined)[0];
        expect(meter?.props).toMatchObject({ remainingPct: 20, resetsAt: NOW + 30 * MIN, resetPrefix: 'next', size: 'wide' });
        const room = screen.root.findAll((node) => node.props?.testID === 'connected-services-pool-detail:left:room' && typeof node.props?.children === 'string')[0];
        expect(room?.props.children).toBe('connectedServicesPool.roomCount(count=1,total=2) · connectedServicesPool.notReported(count=1)');
    });

    it('names who is in use and what happens when it runs out, and switches by hand to the next member', async () => {
        const { screen, group } = await renderPoolDetail({
            policy: policy({ strategy: 'priority', autoSwitch: true }),
            activeSince: { accountId: 'work', atMs: NOW - 30 * MIN },
        });
        const now = itemProps(screen, 'connected-services-pool-detail:now');
        expect(now.title).toMatch(/^connectedServicesPool\.usingSince\(name=work@example\.com,time=/);
        expect(now.subtitle).toBe('connectedServicesPool.leadInOrder connectedServicesPool.fallbackDescription');

        await pressRow(screen, 'connected-services-pool-detail:now:switch');
        expect(setActiveAccount).toHaveBeenCalledWith(expect.objectContaining({ group, account: expect.objectContaining({ accountId: 'backup' }) }));
    });

    it('does not claim a since time the pool has not tied to the active member', async () => {
        const { screen } = await renderPoolDetail({ activeSince: null });
        expect(itemProps(screen, 'connected-services-pool-detail:now').title).toBe('connectedServicesPool.using(name=work@example.com)');
    });

    it('keeps the active account when usage-limit switching is disabled, while still allowing Switch now', async () => {
        const { screen, group } = await renderPoolDetail({
            policy: policy({
                strategy: 'priority',
                autoSwitch: true,
                switchOn: { ...policy().switchOn, usageLimit: false },
            }),
        });
        expect(itemProps(screen, 'connected-services-pool-detail:now').subtitle)
            .toBe('connectedServicesPool.leadInOrder connectedServicesPool.fallbackOff(name=work@example.com)');
        await pressRow(screen, 'connected-services-pool-detail:now:switch');
        expect(setActiveAccount).toHaveBeenCalledWith(expect.objectContaining({ group, account: expect.objectContaining({ accountId: 'backup' }) }));
    });

    it('with one member on, says there is nothing to fall back to and offers to turn the next one on', async () => {
        const { screen, group } = await renderPoolDetail({
            members: [
                { ref: accountRef('work'), priority: 100, enabled: true, state: {} },
                { ref: accountRef('backup'), priority: 200, enabled: false, state: {} },
            ],
        });
        expect(itemProps(screen, 'connected-services-pool-detail:now').subtitle).toBe('connectedServicesPool.onlyOneOn(name=work@example.com)');
        await pressRow(screen, 'connected-services-pool-detail:now:turn-on');
        expect(patchMember).toHaveBeenCalledWith(expect.objectContaining({ group, account: expect.objectContaining({ accountId: 'backup' }), enabled: true }));
    });

    it('when every member is waiting, names the first one back', async () => {
        const { screen } = await renderPoolDetail({}, {
            memberQuotaByAccountId: quota({
                work: snapshot('work', [{ id: '5h', label: '5-hour', left: 0, resetsInMs: 90 * MIN }]),
                backup: snapshot('backup', [{ id: '5h', label: '5-hour', left: 0, resetsInMs: 30 * MIN }]),
            }),
        });
        const now = itemProps(screen, 'connected-services-pool-detail:now');
        expect(now.title).toBe('connectedServicesPool.allWaitingTitle');
        expect(now.subtitle).toMatch(/^connectedServicesPool\.allWaitingFirst\(name=backup@example\.com,/);
    });

    it('★ makes the pool an agent\'s default and Used by names the agents that use it', async () => {
        const setDefault = vi.fn();
        const { screen } = await renderPoolDetail({}, {
            agentDefaults: {
                choices: [
                    { agentId: 'codex', title: 'Codex', isDefault: true },
                    { agentId: 'opencode', title: 'OpenCode', isDefault: false },
                ],
                setDefault,
            },
        });
        const star = screen.root.findAll((candidate) => typeof candidate.type !== 'string' && Array.isArray(candidate.props.items) && typeof candidate.props.onSelect === 'function')
            .find((node) => node.props.items?.some((item: { id: string }) => item.id === 'opencode'));
        await act(async () => { star?.props.onSelect('opencode'); });
        expect(setDefault).toHaveBeenCalledWith('opencode', true);
        await act(async () => { star?.props.onSelect('codex'); });
        expect(setDefault).toHaveBeenCalledWith('codex', false);
        expect(screen.findByTestId('connected-services-pool-detail:used-by:Codex')).not.toBeNull();
        expect(screen.findByTestId('connected-services-pool-detail:used-by:OpenCode')).toBeNull();
    });

    it('offers each membership candidate with its name and identity line', async () => {
        const { screen } = await renderPoolDetail();
        const options = membersDropdown(screen).props.items as ReadonlyArray<{ id: string; title: string; subtitle?: string }>;
        expect(options.map((option) => option.id)).toEqual(['work', 'backup', 'spare']);
        expect(options[0]).toMatchObject({ title: 'work@example.com' });
        expect(options[0]?.subtitle).toBeUndefined();
    });

    it('toggling a member switch patches that member', async () => {
        const { screen, group } = await renderPoolDetail();
        await act(async () => { memberRow(screen, 'backup').onEnabledChange?.(false); });
        await flush();
        expect(patchMember).toHaveBeenCalledTimes(1);
        expect(patchMember.mock.calls[0]?.[0]).toMatchObject({ group, account: { accountId: 'backup' }, enabled: false });
    });

    it('admits a qualified semantic move and refuses stale membership and no-ops', async () => {
        await act(async () => storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' } }));
        const { screen, group } = await renderPoolDetail();
        const binding = screen.root.findByType(EntityFlatReorderList).props.binding;
        const workItem = binding.getItem('work');
        expect(workItem).toMatchObject({ kind: 'pool-member', scope: { serverId: 'home-a', accountId: 'account-a' }, pool: group.ref, member: accountRef('work') });
        if (workItem?.kind !== 'pool-member') throw new Error('Expected the work pool member drag item');
        expect(binding.resolve('work', { anchorId: 'backup', placement: 'after' })).toMatchObject({ status: 'allowed', effect: { actionId: 'connectedServices.pools.reorder', input: { group: group.ref, move: { accountId: 'work', position: { anchorId: 'backup', placement: 'after' } } } } });
        expect(binding.resolve('work', { anchorId: 'backup', placement: 'before' }).status).toBe('refused');
        expect(binding.resolve('missing', { anchorId: 'backup', placement: 'after' }).status).toBe('refused');
        expect(binding.getSourceId({ ...workItem, pool: { ...group.ref, groupId: 'other' } })).toBeNull();
        const currentProps = { accounts: ACCOUNTS, serviceLabel: 'Codex', now: NOW, mutations: createMutations() };
        await screen.update(<QualifiedPoolDetailView {...currentProps} group={{ ...group, members: [
            ...group.members, { ref: accountRef('spare'), priority: 150, enabled: true, state: {} },
        ] }} />);
        const latest = screen.root.findByType(EntityFlatReorderList).props.binding;
        expect(latest.items.map((item: { id: string }) => item.id)).toEqual(['work', 'spare', 'backup']);
        expect(latest.resolve('work', { anchorId: 'backup', placement: 'after' })).toMatchObject({ status: 'allowed', effect: { input: { move: { accountId: 'work', position: { anchorId: 'backup', placement: 'after' } } } } });
        await screen.update(<QualifiedPoolDetailView {...currentProps} group={{ ...group, members: group.members.filter(member => member.ref.accountId !== 'backup') }} />);
        expect(screen.root.findByType(EntityFlatReorderList).props.binding.resolve('work', { anchorId: 'backup', placement: 'after' }).status).toBe('refused');
        expect(patchMember).not.toHaveBeenCalled();
    });

    it('disables move-up on the first member and move-down on the last', async () => {
        const { screen } = await renderPoolDetail();
        expect(memberAction(screen, 'work', 'move-up').disabled).toBe(true);
        expect(memberAction(screen, 'backup', 'move-down').disabled).toBe(true);
        expect(memberAction(screen, 'work', 'move-down').disabled).toBe(false);
    });

    it('the radio makes a non-active member the active one', async () => {
        const { screen, group } = await renderPoolDetail();
        expect(memberRow(screen, 'work').onMakeActive).toBeNull();
        await act(async () => { memberRow(screen, 'backup').onMakeActive?.(); });
        await flush();
        expect(setActiveAccount).toHaveBeenCalledTimes(1);
        expect(setActiveAccount.mock.calls[0]?.[0]).toMatchObject({ group, account: { accountId: 'backup' } });
    });

    it('confirms before removing a member and does not remove when declined', async () => {
        const { screen } = await renderPoolDetail();
        await press(memberAction(screen, 'backup', 'remove'));
        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(removeMember).not.toHaveBeenCalled();
        modalSpies.confirm.mockResolvedValue(true);
        await press(memberAction(screen, 'backup', 'remove'));
        expect(removeMember).toHaveBeenCalledTimes(1);
        expect(removeMember.mock.calls[0]?.[0]).toMatchObject({ account: { accountId: 'backup' } });
    });

    it('Manage members adds the accounts checked in its list', async () => {
        const { screen } = await renderPoolDetail();
        await act(async () => { membersDropdown(screen).props.onOpenChange?.(true); });
        await act(async () => { membersDropdown(screen).props.onSelect?.('spare'); });
        await act(async () => { membersDropdown(screen).props.onOpenChange?.(false); });
        await flush();
        expect(addMember).toHaveBeenCalledTimes(1);
        expect(addMember.mock.calls[0]?.[0]).toMatchObject({ account: { accountId: 'spare' } });
    });

    it('heads the page with the pool name and how many members are on', async () => {
        const { screen } = await renderPoolDetail({
            members: [
                { ref: accountRef('work'), priority: 100, enabled: true, state: {} },
                { ref: accountRef('backup'), priority: 200, enabled: false, state: {} },
            ],
        });
        expect(screen.getTextContent()).toContain('Team pool');
        expect(screen.getTextContent()).toContain('connectedServicesPool.membersOn(service=Codex,on=1,total=2)');
    });

    it('names a pool whose display name is only whitespace by its service title', async () => {
        const { screen } = await renderPoolDetail({ displayName: '   ' });
        expect(screen.getTextContent()).toContain('Codex');
    });

    it('renames the pool inline only after saving the draft', async () => {
        const { screen, group } = await renderPoolDetail();
        await pressRow(screen, 'connected-services-pool-detail:rename');
        expect(patch).not.toHaveBeenCalled();
        const field = screen.findByTestId('connected-services-pool-detail:name-field');
        expect(field).not.toBeNull();
        await act(async () => { field!.props.onChangeText('  Renamed pool  '); });
        await pressRow(screen, 'connected-services-pool-detail:name-save');
        expect(modalSpies.prompt).not.toHaveBeenCalled();
        expect(patch).toHaveBeenCalledTimes(1);
        expect(patch.mock.calls[0]?.[0]).toMatchObject({ group, displayName: 'Renamed pool' });
    });

    it('does not offer one pool name draft to a different pool', async () => {
        const { screen, group } = await renderPoolDetail();
        await pressRow(screen, 'connected-services-pool-detail:rename');
        await act(async () => { screen.findByTestId('connected-services-pool-detail:name-field')!.props.onChangeText('First pool draft'); });
        await screen.update(<QualifiedPoolDetailView accounts={ACCOUNTS} serviceLabel="Codex" now={NOW}
            group={{ ...group, ref: { ...group.ref, groupId: 'another-pool' } }} mutations={createMutations()} />);
        expect(screen.findByTestId('connected-services-pool-detail:name-field') === null).toBe(true);
        expect(patch).not.toHaveBeenCalled();
    });

    it('patches automatic fallback, strategy and the switch-early threshold', async () => {
        const { screen, group } = await renderPoolDetail();
        const strategy = itemProps(screen, 'connected-services-pool-detail:strategy');
        expect(strategy.value).toBe('expiry_first');
        expect(strategy.options.map((option: { id: string }) => option.id)).toContain('expiry_first');
        await act(async () => {
            switchByTestId(screen, 'connected-services-pool-detail:auto-switch:toggle').props.onValueChange?.(true);
        });
        await flush();
        expect(patch.mock.calls[0]?.[0]).toMatchObject({ group, policy: { autoSwitch: true } });

        await act(async () => { itemProps(screen, 'connected-services-pool-detail:strategy').onChange?.('expiry_first'); });
        await flush();
        expect(patch.mock.calls[1]?.[0]).toMatchObject({ policy: { strategy: 'expiry_first' } });

        await act(async () => { itemProps(screen, 'connected-services-pool-detail:soft-switch-threshold').onCommit('25'); });
        await flush();
        expect(patch.mock.calls[2]?.[0]).toMatchObject({ policy: { softSwitchRemainingPercent: 25 } });
    });

    it('keeps an out-of-range switch-early value out of the policy and restores the saved one', async () => {
        const { screen } = await renderPoolDetail();
        let shown: string | void = undefined;
        await act(async () => { shown = itemProps(screen, 'connected-services-pool-detail:soft-switch-threshold').onCommit('180'); });
        expect(shown).toBe('15');
        expect(patch).not.toHaveBeenCalled();
    });

    it('patches every advanced policy control', async () => {
        const { screen } = await renderPoolDetail({}, { initialAdvancedExpanded: true });

        await act(async () => {
            switchByTestId(screen, 'connected-services-pool-detail:auto-restore-primary:toggle').props.onValueChange?.(true);
        });
        await flush();
        expect(patch.mock.calls.at(-1)?.[0]).toMatchObject({ policy: { autoRestorePrimaryWhenReset: true } });

        for (const key of ['usageLimit', 'authExpired', 'accountChanged', 'refreshFailure'] as const) {
            const current = createGroup().policy.switchOn[key];
            await pressRow(screen, `connected-services-pool-detail:switch-on:${key}`);
            expect(patch.mock.calls.at(-1)?.[0]).toMatchObject({
                policy: { switchOn: { ...createGroup().policy.switchOn, [key]: !current } },
            });
        }

        await act(async () => { itemProps(screen, 'connected-services-pool-detail:stale-probe-after').onCommit('10'); });
        expect(patch.mock.calls.at(-1)?.[0]).toMatchObject({ policy: { probeIfSnapshotOlderThanMs: 600_000 } });
        await act(async () => { itemProps(screen, 'connected-services-pool-detail:switches-per-turn').onCommit('2'); });
        expect(patch.mock.calls.at(-1)?.[0]).toMatchObject({ policy: { maxSwitchesPerTurn: 2 } });
        await act(async () => { itemProps(screen, 'connected-services-pool-detail:switches-per-hour').onCommit('6'); });
        expect(patch.mock.calls.at(-1)?.[0]).toMatchObject({ policy: { maxSwitchesPerSessionHour: 6 } });

        await act(async () => {
            dropdownByTriggerTestId(screen, 'connected-services-pool-detail:recovery-mode').props.onSelect?.('off');
        });
        await flush();
        expect(patch.mock.calls.at(-1)?.[0]).toMatchObject({ policy: { recoveryMode: 'off' } });
        expect(screen.findByTestId('connected-services-pool-detail:recovery-prompt')).not.toBeNull();
    });

    it('keeps the advanced controls collapsed until the disclosure is opened', async () => {
        const { screen } = await renderPoolDetail();
        expect(screen.findByTestId('connected-services-pool-detail:switches-per-turn')).toBeNull();
        await pressRow(screen, 'connected-services-pool-detail:advanced:header');
        expect(screen.findByTestId('connected-services-pool-detail:switches-per-turn')).not.toBeNull();
    });

    it('confirms before deleting the pool', async () => {
        const { screen, group } = await renderPoolDetail();
        await pressRow(screen, 'connected-services-pool-detail:delete');
        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(deleteGroup).not.toHaveBeenCalled();
        modalSpies.confirm.mockResolvedValue(true);
        await pressRow(screen, 'connected-services-pool-detail:delete');
        expect(deleteGroup).toHaveBeenCalledWith(group);
    });

    it('disables the fallback controls when automatic fallback is unavailable', async () => {
        const { screen } = await renderPoolDetail({}, { fallbackControlsEnabled: false, fallbackDisabledSubtitle: 'unsupported' });
        expect(switchByTestId(screen, 'connected-services-pool-detail:auto-switch:toggle').props.disabled).toBe(true);
        await act(async () => {
            switchByTestId(screen, 'connected-services-pool-detail:auto-switch:toggle').props.onValueChange?.(true);
        });
        await flush();
        expect(patch).not.toHaveBeenCalled();
        expect(memberRow(screen, 'backup').onMakeActive).toBeNull();
    });

    it('invites members when the pool has none, and the invitation opens Manage members', async () => {
        const { screen } = await renderPoolDetail({ members: [], activeAccountId: null });
        expect(memberRows(screen)).toHaveLength(0);
        const empty = screen.root.findAll((node) => node.props?.testID === 'connected-services-pool-detail:no-members' && node.props?.action)[0];
        expect(empty).toBeTruthy();
        await act(async () => { empty?.props.action.onPress(); });
        expect(membersDropdown(screen).props.open).toBe(true);
    });

    it('surfaces a failed mutation instead of letting the change fail silently', async () => {
        const { screen } = await renderPoolDetail({}, { error: 'connect_group_generation_conflict' });
        const errorNode = screen.root
            .findAll((node) => node.props?.testID === 'connected-services-pool-detail:error')
            .find((node) => node.props?.description === 'connect_group_generation_conflict');
        expect(errorNode).toBeTruthy();
        const none = await renderPoolDetail();
        expect(none.screen.root.findAll((node) => node.props?.testID === 'connected-services-pool-detail:error')).toHaveLength(0);
    });
});

function quotaLimitsMenu(screen: Screen) {
    return screen.root
        .findAll((candidate) => typeof candidate.type !== 'string' && Array.isArray(candidate.props.items) && typeof candidate.props.onSelect === 'function')
        .find((candidate) => candidate.props.items?.some((item: { title?: string }) => (
            item.title === 'connectedServices.detail.groupDetail.quotaLimitsAllTitle'
        )));
}

function moreMenu(screen: Screen) {
    const node = screen.root.findAll((candidate) => typeof candidate.type !== 'string' && Array.isArray(candidate.props.items) && typeof candidate.props.onSelect === 'function')
        .find((candidate) => candidate.props.items?.some((item: { id: string }) => item.id === 'delete'));
    if (!node) throw new Error('no pool menu');
    return node;
}
