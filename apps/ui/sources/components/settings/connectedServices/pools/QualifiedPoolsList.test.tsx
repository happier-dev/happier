import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import {
    ConnectedServiceAuthGroupPolicyV1Schema,
    QualifiedConnectedAccountQuotaSnapshotV4Schema,
    type ConnectedServiceCredentialHealthStatusV1,
    type QualifiedConnectedAccountQuotaSnapshotV4,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
    QualifiedConnectedAccountUiGroup,
    QualifiedConnectedAccountUiGroupMember,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';

import {
    QualifiedPoolsList,
    type QualifiedPoolAccount,
} from './QualifiedPoolsList';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = 1_000_000_000;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}(${JSON.stringify(params)})` : key
        ),
    });
});

const featureState = vi.hoisted(() => ({ quotasEnabled: true }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => (
        featureId === 'connectedServices.quotas' ? featureState.quotasEnabled : true
    ),
}));

/**
 * Boundary mock: the qualified quota hook is the server-snapshot data source for
 * each member probe. The real gauge/health/ring derivation below it stays live.
 */
const quotaState = vi.hoisted(() => ({
    snapshotsByAccountId: new Map<string, unknown>(),
    loadingAccountIds: new Set<string>(),
    probedAccountIds: [] as string[],
}));
vi.mock('@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota', () => ({
    useQualifiedConnectedAccountQuota: (ref: { accountId: string }) => {
        quotaState.probedAccountIds.push(ref.accountId);
        return {
            supported: true,
            snapshot: quotaState.snapshotsByAccountId.get(ref.accountId) ?? null,
            loading: quotaState.loadingAccountIds.has(ref.accountId),
            refreshing: false,
            error: null,
            refresh: async () => {},
        };
    },
}));

const SERVICE = { pluginId: 'happier.anthropic', localId: 'anthropic' } as const;

function accountRef(accountId: string): QualifiedConnectedAccountRef {
    return { service: { ...SERVICE }, accountId };
}

/** A snapshot whose single meter leaves `remainingPct` capacity (0..100). */
function snapshotWithRemainingPct(
    accountId: string,
    remainingPct: number,
): QualifiedConnectedAccountQuotaSnapshotV4 {
    return QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
        v: 1,
        ref: accountRef(accountId),
        fetchedAt: NOW_MS,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [
            {
                meterId: 'weekly',
                label: 'Weekly',
                used: 100 - remainingPct,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                resetsAt: null,
                status: 'ok',
                details: {},
            },
        ],
    });
}

function member(
    accountId: string,
    overrides: Partial<Omit<QualifiedConnectedAccountUiGroupMember, 'ref'>> = {},
): QualifiedConnectedAccountUiGroupMember {
    return {
        ref: accountRef(accountId),
        priority: 100,
        enabled: true,
        state: {},
        ...overrides,
    };
}

function buildGroup(
    overrides: Partial<Omit<QualifiedConnectedAccountUiGroup, 'ref' | 'policy'>> & {
        groupId?: string;
        policy?: Readonly<{ autoSwitch?: boolean; strategy?: 'priority' | 'least_limited' | 'manual' }>;
    } = {},
): QualifiedConnectedAccountUiGroup {
    const { groupId, policy, ...rest } = overrides;
    return {
        ref: { service: { ...SERVICE }, groupId: groupId ?? 'pool-1' },
        displayName: 'Primary pool',
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({
            autoSwitch: policy?.autoSwitch ?? true,
            strategy: policy?.strategy ?? 'priority',
        }),
        activeAccountId: 'work',
        revision: {
            protocol: 'v4',
            incarnation: `qualified-group-row:${groupId ?? 'pool-1'}`,
            generation: 1,
            runtimeStateRevision: 1,
        },
        state: {},
        members: [member('work'), member('home')],
        ...rest,
    };
}

function account(
    accountId: string,
    status: ConnectedServiceCredentialHealthStatusV1 = 'connected',
    identity: Readonly<{ displayName?: string; providerEmail?: string }> = {},
): QualifiedPoolAccount {
    return {
        ref: accountRef(accountId),
        status,
        displayName: identity.displayName ?? null,
        providerIdentity: identity.providerEmail ? { email: identity.providerEmail } : null,
    };
}

/** Flattens a rendered node's children (strings/numbers/nested elements) to text. */
function flattenRenderedText(value: unknown): string {
    if (value === null || value === undefined || typeof value === 'boolean') return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(flattenRenderedText).join('');
    if (typeof value === 'object' && 'props' in value) {
        return flattenRenderedText((value as { props?: { children?: unknown } }).props?.children);
    }
    return '';
}

type RenderOverrides = Readonly<{
    groups?: readonly QualifiedConnectedAccountUiGroup[];
    accounts?: readonly QualifiedPoolAccount[];
    accountLabels?: Readonly<Record<string, string | undefined>>;
    status?: React.ComponentProps<typeof QualifiedPoolsList>['status'];
    poolConfigurationSupported?: boolean;
    onRetryLoad?: () => void;
    serviceLabel?: string;
}>;

let onOpenPool: ReturnType<typeof vi.fn>;
let onCreatePool: ReturnType<typeof vi.fn>;
let onRetryLoad: ReturnType<typeof vi.fn>;

function renderPools(overrides: RenderOverrides = {}) {
    return renderScreen(
        <QualifiedPoolsList
            groups={overrides.groups ?? [buildGroup()]}
            accounts={overrides.accounts ?? [account('work'), account('home')]}
            accountLabels={overrides.accountLabels}
            serviceLabel={overrides.serviceLabel ?? 'Anthropic'}
            status={overrides.status ?? 'loaded'}
            poolConfigurationSupported={overrides.poolConfigurationSupported ?? true}
            onOpenPool={onOpenPool}
            onCreatePool={onCreatePool}
            onRetryLoad={'onRetryLoad' in overrides ? overrides.onRetryLoad : onRetryLoad}
        />,
    );
}

beforeEach(() => {
    featureState.quotasEnabled = true;
    quotaState.snapshotsByAccountId = new Map();
    quotaState.loadingAccountIds = new Set();
    quotaState.probedAccountIds = [];
    onOpenPool = vi.fn();
    onCreatePool = vi.fn();
    onRetryLoad = vi.fn();
});

describe('QualifiedPoolsList', () => {
    it('uses the author service title as an unnamed pool primary label, never its opaque id', async () => {
        const screen = await renderPools({
            serviceLabel: 'External Gateway',
            groups: [buildGroup({
                groupId: 'pool_opaque_123',
                displayName: null,
            })],
        });

        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool_opaque_123:label')?.props.children))
            .toBe('External Gateway');
    });

    it('renders a pool row with its label, strategy and enabled counts, and drills in on press', async () => {
        const screen = await renderPools({
            groups: [buildGroup({ members: [member('work'), member('home', { enabled: false })] })],
        });

        expect(screen.findAllByTestId('connected-services-pool:pool-1').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('connected-services-pool:pool-1:avatar').length).toBeGreaterThan(0);
        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:label')?.props.children))
            .toBe('Primary pool');
        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:strategy')?.props.children))
            .toBe('connectedServices.detail.groups.strategyPriority');
        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:members')?.props.children))
            .toBe('connectedServices.detail.groups.enabledMembers({"enabled":1,"total":2})');

        screen.pressByTestId('connected-services-pool:pool-1');
        expect(onOpenPool).toHaveBeenCalledWith('pool-1');
    });

    it('labels the active member from the account-label map', async () => {
        const screen = await renderPools({ accountLabels: { work: 'Work account' } });

        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:active')?.props.children))
            .toBe('Work account');
    });

    it('names an unlabelled active member by its provider identity, never the raw account id', async () => {
        // An account id is an opaque handle. With no user label the row falls back to
        // the account's provider EMAIL, and only to the plugin's display name when
        // there is no email — the one documented precedence (user label > provider
        // email > display name > id) every connected-services surface shares, so the
        // same account is never named two different ways.
        const emailed = await renderPools({
            accounts: [
                account('work', 'connected', { displayName: 'Work workspace', providerEmail: 'work@example.com' }),
                account('home'),
            ],
        });
        expect(flattenRenderedText(emailed.findByTestId('connected-services-pool:pool-1:active')?.props.children))
            .toBe('work@example.com');

        const displayNameOnly = await renderPools({
            accounts: [account('work', 'connected', { displayName: 'Work workspace' }), account('home')],
        });
        expect(flattenRenderedText(displayNameOnly.findByTestId('connected-services-pool:pool-1:active')?.props.children))
            .toBe('Work workspace');
    });

    it('shows the Auto badge for an auto-switching pool and the Manual badge otherwise', async () => {
        const auto = await renderPools();
        expect(auto.findByTestId('connected-services-pool:pool-1:mode:variant:info')).toBeTruthy();
        expect(flattenRenderedText(auto.findByTestId('connected-services-pool:pool-1:mode:label')?.props.children))
            .toBe('connectedServices.pools.autoBadge');

        const manual = await renderPools({
            groups: [buildGroup({ policy: { autoSwitch: false, strategy: 'manual' } })],
        });
        expect(manual.findByTestId('connected-services-pool:pool-1:mode:variant:neutral')).toBeTruthy();
        expect(flattenRenderedText(manual.findByTestId('connected-services-pool:pool-1:mode:label')?.props.children))
            .toBe('connectedServices.pools.manualBadge');
        expect(flattenRenderedText(manual.findByTestId('connected-services-pool:pool-1:strategy')?.props.children))
            .toBe('connectedServices.detail.groups.strategyManual');
    });

    it('counts only ENABLED members that need attention in the warning chip', async () => {
        // `work` (enabled) is critically low, `home` (DISABLED) is too — only the
        // enabled one may be counted.
        quotaState.snapshotsByAccountId.set('work', snapshotWithRemainingPct('work', 5));
        quotaState.snapshotsByAccountId.set('home', snapshotWithRemainingPct('home', 5));

        const screen = await renderPools({
            groups: [buildGroup({ members: [member('work'), member('home', { enabled: false })] })],
        });
        await flushHookEffects({ turns: 4 });

        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:warnings:label')?.props.children))
            .toBe('1');
        // The active member's capacity reads from the gauge avatar's center number.
        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:avatar:capacity')?.props.children))
            .toBe('5');
    });

    it('counts a member that needs reauth without probing its quota', async () => {
        const screen = await renderPools({
            accounts: [account('work', 'needs_reauth'), account('home')],
        });
        await flushHookEffects({ turns: 4 });

        expect(quotaState.probedAccountIds).not.toContain('work');
        expect(quotaState.probedAccountIds).toContain('home');
        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:warnings:label')?.props.children))
            .toBe('1');
    });

    it('drops a resolved capacity once that member starts needing reauth', async () => {
        // The active member first reports capacity through its live probe. When
        // its credential then needs reauth the probe stops mounting, so the
        // retained resolution is STALE — if it kept winning, the row would go on
        // advertising usable capacity for an account that cannot be used at all.
        quotaState.snapshotsByAccountId.set('work', snapshotWithRemainingPct('work', 90));

        const screen = await renderPools({ accounts: [account('work'), account('home')] });
        await flushHookEffects({ turns: 4 });
        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:avatar:capacity')?.props.children))
            .toBe('90');

        await act(async () => {
            screen.tree.update(
                <QualifiedPoolsList
                    groups={[buildGroup()]}
                    accounts={[account('work', 'needs_reauth'), account('home')]}
                    serviceLabel="Anthropic"
                    status="loaded"
                    poolConfigurationSupported
                    onOpenPool={onOpenPool}
                    onCreatePool={onCreatePool}
                    onRetryLoad={onRetryLoad}
                />,
            );
        });
        await flushHookEffects({ turns: 4 });

        expect(screen.findAllByTestId('connected-services-pool:pool-1:avatar:capacity')).toHaveLength(0);
    });

    it('shows no warning chip and no capacity while the quotas feature is disabled', async () => {
        featureState.quotasEnabled = false;
        quotaState.snapshotsByAccountId.set('work', snapshotWithRemainingPct('work', 5));

        const screen = await renderPools();
        await flushHookEffects({ turns: 4 });

        expect(quotaState.probedAccountIds).toHaveLength(0);
        expect(screen.findAllByTestId('connected-services-pool:pool-1:warnings')).toHaveLength(0);
        expect(screen.findAllByTestId('connected-services-pool:pool-1:avatar:capacity')).toHaveLength(0);
        expect(screen.findAllByTestId('connected-services-pool:pool-1:avatar').length).toBeGreaterThan(0);
    });

    it('shows a loading gauge for the active member until its usage lands', async () => {
        // A pending usage read must not render as a resolved, empty gauge.
        quotaState.loadingAccountIds.add('work');

        const screen = await renderPools();
        await flushHookEffects({ turns: 4 });

        expect(screen.findAllByTestId('connected-services-pool:pool-1:avatar:loading').length)
            .toBeGreaterThan(0);
        expect(screen.findAllByTestId('connected-services-pool:pool-1:avatar:capacity')).toHaveLength(0);
    });

    it('names a pool whose display name is only whitespace by its author service title', async () => {
        const screen = await renderPools({ groups: [buildGroup({ displayName: '   ' })] });

        expect(flattenRenderedText(screen.findByTestId('connected-services-pool:pool-1:label')?.props.children))
            .toBe('Anthropic');
    });

    it('renders the empty state plus the create card when a settled load has no pools', async () => {
        const screen = await renderPools({ groups: [], status: 'loaded' });

        expect(screen.findByTestId('connected-services-pools:empty:title')).toBeTruthy();
        expect(screen.findAllByTestId('connected-services-pools:load-error')).toHaveLength(0);
        expect(screen.findAllByTestId('connected-services-pool-action:create').length).toBeGreaterThan(0);
    });

    it('shows an explicit loading row, never the empty state, while the first authoritative load is pending', async () => {
        const screen = await renderPools({ groups: [], status: 'loading' });

        expect(screen.findAllByTestId('connected-services-pools:empty:title')).toHaveLength(0);
        expect(screen.findAllByTestId('connected-services-pools:load-error')).toHaveLength(0);
        // Without this row the pending load renders as a bare titled section, which
        // reads exactly like a settled "no pools" answer.
        expect(screen.findByTestId('connected-services-pools:loading')).toBeTruthy();
        expect(screen.findAllByTestId('connected-services-pool-action:create').length).toBeGreaterThan(0);
    });

    it('shows an explicit load-error state with retry (never "no pools") when the load failed with no data', async () => {
        const screen = await renderPools({ groups: [], status: 'error' });

        expect(screen.findAllByTestId('connected-services-pools:empty:title')).toHaveLength(0);
        expect(screen.findByTestId('connected-services-pools:load-error')).toBeTruthy();

        screen.pressByTestId('connected-services-pools:load-error:retry');
        expect(onRetryLoad).toHaveBeenCalledTimes(1);
    });

    it('keeps the last-known rows and offers an inline retry when a refresh fails', async () => {
        const screen = await renderPools({ groups: [buildGroup()], status: 'error' });

        expect(screen.findAllByTestId('connected-services-pool:pool-1').length).toBeGreaterThan(0);
        expect(screen.findByTestId('connected-services-pools:stale-error')).toBeTruthy();

        screen.pressByTestId('connected-services-pools:stale-error:retry');
        expect(onRetryLoad).toHaveBeenCalledTimes(1);
    });

    it('invokes onCreatePool from the create card, and disables it when configuration is unsupported', async () => {
        const enabled = await renderPools();
        enabled.pressByTestId('connected-services-pool-action:create');
        expect(onCreatePool).toHaveBeenCalledTimes(1);

        const disabled = await renderPools({ poolConfigurationSupported: false });
        const createItem = disabled.find((node) => (
            node.props?.testID === 'connected-services-pool-action:create'
            && typeof node.props?.disabled === 'boolean'
        ));
        expect(createItem.props.disabled).toBe(true);
        expect(createItem.props.onPress).toBeUndefined();
    });
});
