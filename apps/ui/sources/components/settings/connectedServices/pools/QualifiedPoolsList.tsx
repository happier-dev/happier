import * as React from 'react';
import { View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import type {
    QualifiedConnectedAccountGroupsStatus,
} from '@/hooks/server/connectedServices/useQualifiedConnectedAccountGroups';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    computeConnectedServiceQuotaGaugeViewModel,
    type ConnectedServiceQuotaGaugeLabelFormatter,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { deriveAccountCapacityPct } from '@/sync/domains/connectedServices/deriveAccountCapacityPct';
import {
    deriveAccountHealth,
    worstAccountHealth,
    type AccountHealth,
} from '@/sync/domains/connectedServices/deriveAccountHealth';
import type {
    QualifiedConnectedAccountUiGroup,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import {
    shouldHideQuotaForCredentialStatus,
} from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { t } from '@/text';
import type {
    ConnectedServiceCredentialHealthStatusV1,
    QualifiedConnectedAccountQuotaSnapshotV4,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import {
    resolveAccountCapacityRings,
    resolveAccountHealthVariant,
    resolveAccountUsageRows,
    type CapacityRingDatum,
} from '../account/accountBlockModel';
import {
    ConnectedServiceCapacityAvatar,
    CONNECTED_SERVICE_GAUGE_BOX,
} from '../ConnectedServiceCapacityAvatar';
import {
    presentQualifiedConnectedAccountTarget,
    type QualifiedConnectedAccountPresentationAccount,
    type QualifiedConnectedAccountTargetPresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';

/** Ring-avatar footprint for the row leading element. */
const POOL_AVATAR_SIZE = 42;

/** Shared empty ring set so a member without a snapshot never churns the avatar's props. */
const EMPTY_RINGS: readonly CapacityRingDatum[] = Object.freeze([]);
const EMPTY_CONNECTED_ACCOUNT_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({});

/**
 * The gauge view-model is the canonical "snapshot → meter rows" owner. Capacity
 * derivation reads only the numeric `remainingPct` from those rows, so the label
 * strings are never surfaced here and a no-op formatter is correct.
 */
const NOOP_GAUGE_LABEL_FORMATTER: ConnectedServiceQuotaGaugeLabelFormatter = {
    remaining: () => '',
    remainingWithReset: () => '',
    used: () => '',
    durationNow: () => '',
    durationOutdated: () => '',
    durationDaysHours: () => '',
    durationHoursMinutes: () => '',
    durationHours: () => '',
    durationMinutes: () => '',
};

export type QualifiedPoolMemberGauge = Readonly<{
    capacityPct: number | null;
    rings: CapacityRingDatum[];
}>;

/**
 * Compute the gauge view-model ONCE from a snapshot and return both the overall
 * capacity (min remaining % across comparable meters) and the concentric rings
 * (one per limit, most-constrained outermost). A single pass keeps the row gauge
 * and the center % from ever drifting.
 */
function deriveSnapshotGauge(
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4 | null,
): QualifiedPoolMemberGauge {
    if (!snapshot) return { capacityPct: null, rings: [] };
    const viewModel = computeConnectedServiceQuotaGaugeViewModel({
        snapshot,
        windowMode: 'most_constrained',
        // Capacity is time-independent; a stable `nowMs` keeps the memo dependency tight.
        nowMs: snapshot.fetchedAt,
        formatter: NOOP_GAUGE_LABEL_FORMATTER,
    });
    if (!viewModel) return { capacityPct: null, rings: [] };
    return {
        capacityPct: deriveAccountCapacityPct(viewModel.allMeterRows),
        rings: resolveAccountCapacityRings(resolveAccountUsageRows(viewModel.allMeterRows)),
    };
}

export type QualifiedPoolMemberResolution = Readonly<{
    health: AccountHealth;
    capacityPct: number | null;
    rings: readonly CapacityRingDatum[];
    /** True while this member's usage read has not landed yet (first load / refetch). */
    loading: boolean;
}>;

/** Stable structural key for a ring set (order-sensitive); used for render-loop dedup. */
function ringsKeyOf(rings: ReadonlyArray<CapacityRingDatum>): string {
    return rings.map((ring) => `${ring.ratio}:${ring.tone}`).join('|');
}

/**
 * The account facts a pool row needs about its members. Deliberately structural
 * and minimal: any qualified account projection (e.g. the service detail's
 * account list) satisfies it without this module depending on that screen.
 */
export type QualifiedPoolAccount = QualifiedConnectedAccountPresentationAccount & Readonly<{
    status?: ConnectedServiceCredentialHealthStatusV1 | null;
}>;

/**
 * Headless per-member probe: subscribes to the shared qualified quota snapshot,
 * derives the member's capacity + rings + health once, and reports it up.
 * Rendering one probe per member keeps the snapshot hook call count fixed per
 * component instance (Rules of Hooks) while letting the row aggregate warnings
 * across a dynamic member set.
 */
const QualifiedPoolMemberProbe = React.memo(function QualifiedPoolMemberProbe(props: Readonly<{
    account: QualifiedConnectedAccountRef;
    status: ConnectedServiceCredentialHealthStatusV1 | null;
    onResolve: (accountId: string, resolution: QualifiedPoolMemberResolution) => void;
}>) {
    const { account, status, onResolve } = props;
    const { snapshot, loading } = useQualifiedConnectedAccountQuota(account);

    const gauge = React.useMemo(() => deriveSnapshotGauge(snapshot), [snapshot]);
    // The V4 quota surface reports no staleness flag, so it is derived from the
    // snapshot's own freshness window — the same rule `QualifiedAccountBlock` uses.
    const isStale = snapshot != null && Date.now() > snapshot.fetchedAt + snapshot.staleAfterMs;
    const health = deriveAccountHealth({
        status,
        capacityPct: gauge.capacityPct,
        isStale,
    });

    // `rings` is a fresh array every render; key on its stable structural digest so
    // an unchanged ring set never re-fires the report effect (render-loop safety).
    const ringsKey = ringsKeyOf(gauge.rings);
    const accountId = account.accountId;
    const capacityPct = gauge.capacityPct;
    const rings = gauge.rings;
    React.useEffect(() => {
        onResolve(accountId, { health, capacityPct, rings, loading });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `ringsKey` stands in for the fresh `rings` array.
    }, [onResolve, accountId, health, capacityPct, ringsKey, loading]);

    return null;
});

/**
 * The member's human name, resolved through the shared identity owner so a pool
 * row prints exactly what the account list and the pool detail print.
 */
function presentPoolMember(
    service: QualifiedConnectedAccountRef['service'],
    accountId: string,
    accountsById: ReadonlyMap<string, QualifiedPoolAccount>,
    accountLabels: Readonly<Record<string, string | undefined>>,
    serviceLabel: string,
): QualifiedConnectedAccountTargetPresentation {
    return presentQualifiedConnectedAccountTarget({
        target: {
            kind: 'account',
            account: { service, accountId },
        },
        accounts: [...accountsById.values()],
        groups: [],
        labelsByKey: EMPTY_CONNECTED_ACCOUNT_LABELS,
        accountLabel: accountLabels[accountId],
        serviceTitle: serviceLabel,
    });
}

const QualifiedPoolRow = React.memo(function QualifiedPoolRow(props: Readonly<{
    group: QualifiedConnectedAccountUiGroup;
    accountsById: ReadonlyMap<string, QualifiedPoolAccount>;
    accountLabels: Readonly<Record<string, string | undefined>>;
    serviceLabel: string;
    quotaProbesActive: boolean;
    onOpenPool: (groupId: string) => void;
    /** Injected by {@link ItemGroup}'s row-position distribution; forwarded to the row Item. */
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { accountLabels, accountsById, group, serviceLabel } = props;
    const groupId = group.ref.groupId;
    const rowTestId = `connected-services-pool:${groupId}`;

    const [resolutions, setResolutions] = React.useState<
        Readonly<Record<string, QualifiedPoolMemberResolution>>
    >({});
    const onResolve = React.useCallback((accountId: string, resolution: QualifiedPoolMemberResolution) => {
        setResolutions((prev) => {
            const existing = prev[accountId];
            if (
                existing
                && existing.health === resolution.health
                && existing.capacityPct === resolution.capacityPct
                && existing.loading === resolution.loading
                && ringsKeyOf(existing.rings) === ringsKeyOf(resolution.rings)
            ) {
                return prev;
            }
            return { ...prev, [accountId]: resolution };
        });
    }, []);

    /**
     * Accounts that currently have a live probe mounted below. A member that
     * leaves the pool — or whose credential starts hiding quota — stops being
     * probed, so anything still held for it in `resolutions` is stale.
     */
    const probedAccountIds = React.useMemo(() => new Set(
        group.members
            .map((member) => member.ref.accountId)
            .filter((accountId) => !shouldHideQuotaForCredentialStatus(accountsById.get(accountId)?.status)),
    ), [accountsById, group.members]);

    // Prune stale resolutions rather than letting them keep winning over the
    // status-derived fallback: a retained "healthy, 90% left" reading for an
    // account that now needs reauth would advertise capacity that cannot be used.
    React.useEffect(() => {
        setResolutions((prev) => {
            const keys = Object.keys(prev);
            if (keys.every((accountId) => probedAccountIds.has(accountId))) return prev;
            const next: Record<string, QualifiedPoolMemberResolution> = {};
            for (const accountId of keys) {
                if (probedAccountIds.has(accountId)) next[accountId] = prev[accountId]!;
            }
            return next;
        });
    }, [probedAccountIds]);

    const enabledMembers = React.useMemo(
        () => group.members.filter((member) => member.enabled),
        [group.members],
    );

    /**
     * A member without a live quota resolution still has a credential status, and
     * a reconnect-required account IS a pool warning — so health falls back to the
     * status-only derivation instead of silently reading as healthy.
     */
    const resolveMemberHealth = (accountId: string): AccountHealth => (
        resolutions[accountId]?.health
        ?? deriveAccountHealth({
            status: accountsById.get(accountId)?.status ?? null,
            capacityPct: null,
        })
    );

    const warningCount = enabledMembers.reduce((count, member) => {
        const health = resolveMemberHealth(member.ref.accountId);
        return health === 'attention' || health === 'error' ? count + 1 : count;
    }, 0);
    const aggregateHealth = worstAccountHealth(
        enabledMembers.map((member) => resolveMemberHealth(member.ref.accountId)),
    );
    const warningVariant = resolveAccountHealthVariant(aggregateHealth);

    const activeAccountId = group.activeAccountId;
    const activeResolution = activeAccountId ? resolutions[activeAccountId] : undefined;
    const activeCapacityPct = activeResolution?.capacityPct ?? null;
    const activeRings = activeResolution?.rings ?? EMPTY_RINGS;
    /**
     * The gauge is loading while the active member is actually being probed and
     * its usage has not landed — including before its probe's first report, which
     * would otherwise render as a resolved "no usage" gauge.
     */
    const activeMemberProbed = activeAccountId != null
        && props.quotaProbesActive
        && !shouldHideQuotaForCredentialStatus(accountsById.get(activeAccountId)?.status);
    const activeLoading = activeMemberProbed && (activeResolution?.loading ?? true);
    const activeTitle = activeAccountId
        ? presentPoolMember(
            group.ref.service,
            activeAccountId,
            accountsById,
            accountLabels,
            serviceLabel,
        ).primaryLabel
        : null;

    const poolPresentation = presentQualifiedConnectedAccountTarget({
        target: {
            kind: 'group',
            service: group.ref.service,
            groupId: group.ref.groupId,
        },
        accounts: [...accountsById.values()],
        groups: [group],
        labelsByKey: EMPTY_CONNECTED_ACCOUNT_LABELS,
        serviceTitle: serviceLabel,
    });
    const poolLabel = poolPresentation.primaryLabel;
    const strategyLabel = group.policy.strategy === 'manual'
        ? t('connectedServices.detail.groups.strategyManual')
        : group.policy.strategy === 'least_limited'
            ? t('connectedServices.detail.groups.strategyLeastLimited')
            : t('connectedServices.detail.groups.strategyPriority');

    const leadingElement = (
        <ConnectedServiceCapacityAvatar
            testID={`${rowTestId}:avatar`}
            rings={activeRings}
            centerLabel={activeCapacityPct != null ? String(Math.round(activeCapacityPct)) : null}
            loading={activeLoading}
            size={POOL_AVATAR_SIZE}
            accessibilityLabel={poolPresentation.accessibilityLabel}
        />
    );

    const titleNode = (
        <View style={styles.titleRow}>
            <Text testID={`${rowTestId}:label`} style={styles.title} numberOfLines={1}>{poolLabel}</Text>
            <StatusPill
                testID={`${rowTestId}:mode`}
                variant={group.policy.autoSwitch ? 'info' : 'neutral'}
                hideDot
                label={group.policy.autoSwitch
                    ? t('connectedServices.pools.autoBadge')
                    : t('connectedServices.pools.manualBadge')}
            />
            {warningCount > 0 ? (
                <StatusPill
                    testID={`${rowTestId}:warnings`}
                    variant={warningVariant}
                    leading={(
                        <Icon
                            name="warning"
                            size={ICON_SIZE.xs}
                            color={theme.colors.state[warningVariant].foreground}
                        />
                    )}
                    label={String(warningCount)}
                    accessibilityLabel={t('connectedServices.pools.memberWarningsA11y', { count: warningCount })}
                />
            ) : null}
        </View>
    );

    const subtitleNode = (
        <View style={styles.subtitle}>
            <View style={styles.metaRow}>
                {activeTitle ? (
                    <>
                        <Text testID={`${rowTestId}:active`} style={styles.meta} numberOfLines={1}>{activeTitle}</Text>
                        <Text style={styles.metaSeparator}> · </Text>
                    </>
                ) : null}
                <Text testID={`${rowTestId}:members`} style={styles.meta}>
                    {t('connectedServices.detail.groups.enabledMembers', {
                        enabled: enabledMembers.length,
                        total: group.members.length,
                    })}
                </Text>
                <Text style={styles.metaSeparator}> · </Text>
                <Text testID={`${rowTestId}:strategy`} style={styles.meta}>{strategyLabel}</Text>
            </View>
            {props.quotaProbesActive
                ? group.members.map((member) => {
                    const account = accountsById.get(member.ref.accountId);
                    // A reconnect-required account has no readable usage; probing it
                    // would poll for a snapshot the server cannot produce.
                    if (shouldHideQuotaForCredentialStatus(account?.status)) return null;
                    return (
                        <QualifiedPoolMemberProbe
                            key={member.ref.accountId}
                            account={member.ref}
                            status={account?.status ?? null}
                            onResolve={onResolve}
                        />
                    );
                })
                : null}
        </View>
    );

    return (
        <Item
            testID={rowTestId}
            title={titleNode}
            subtitle={subtitleNode}
            subtitleLines={0}
            leftElement={leadingElement}
            iconBoxSize={CONNECTED_SERVICE_GAUGE_BOX}
            onPress={() => props.onOpenPool(groupId)}
            showDivider={props.showDivider}
        />
    );
});

export type QualifiedPoolsListProps = Readonly<{
    /** Authoritative pools for one qualified service. */
    groups: readonly QualifiedConnectedAccountUiGroup[];
    /** The service's connected accounts, used for member labels and credential health. */
    accounts: readonly QualifiedPoolAccount[];
    /** Applied service descriptor title; the list never derives one from a plugin id. */
    serviceLabel: string;
    /** User-chosen account labels, keyed by account id; falls back to the account's display name. */
    accountLabels?: Readonly<Record<string, string | undefined>>;
    /** Load status of {@link groups}; distinguishes "no pools" from "load failed". */
    status?: QualifiedConnectedAccountGroupsStatus;
    /** Whether this service's runtime can create/configure pools at all. */
    poolConfigurationSupported: boolean;
    onOpenPool: (groupId: string) => void;
    onCreatePool: () => void;
    /** Refetch the authoritative pools after a load failure (the error/stale retry action). */
    onRetryLoad?: () => void;
}>;

/** Stable empty fallback so an absent `accountLabels` prop does not churn memos. */
/**
 * Pools tab list for a qualified connected service: one drill-in row per pool
 * (auth group), an under-the-list "Create pool" action card, and an empty state
 * when no pools exist. Each row's leading gauge and warning count come from
 * headless per-member quota probes, so the pool summary and the account blocks
 * inside the pool detail read from the same quota owner.
 */
export const QualifiedPoolsList = React.memo(function QualifiedPoolsList(props: QualifiedPoolsListProps) {
    const { theme } = useUnistyles();
    const isFocused = useIsFocused();
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const quotaProbesActive = quotasEnabled && isFocused;
    const status = props.status ?? 'idle';
    const pools = props.groups;
    const accountLabels = props.accountLabels ?? EMPTY_CONNECTED_ACCOUNT_LABELS;

    const accountsById = React.useMemo(() => {
        const map = new Map<string, QualifiedPoolAccount>();
        for (const account of props.accounts) map.set(account.ref.accountId, account);
        return map;
    }, [props.accounts]);

    const createCard = (
        <ItemGroup>
            <Item
                testID="connected-services-pool-action:create"
                title={t('connectedServices.pools.create.title')}
                subtitle={props.poolConfigurationSupported
                    ? t('connectedServices.pools.create.subtitle')
                    : t('connectedServices.detail.groupActions.runtimeFallbackUnsupported')}
                icon={<Icon name="plus-circle" size={ICON_SIZE.md} color={theme.colors.accent.blue} />}
                disabled={!props.poolConfigurationSupported}
                onPress={props.poolConfigurationSupported ? props.onCreatePool : undefined}
            />
        </ItemGroup>
    );

    const retryRow = props.onRetryLoad ? (
        <Item
            testID="connected-services-pools:load-error:retry"
            title={t('connectedServices.pools.loadError.retry')}
            icon={<Icon name="arrow-clockwise" size={ICON_SIZE.md} color={theme.colors.accent.blue} />}
            onPress={props.onRetryLoad}
        />
    ) : null;

    // A failed load with NO data to fall back on gets an explicit, actionable error
    // state — never the "No pools yet" empty state, which would silently mask the failure.
    if (pools.length === 0 && status === 'error') {
        return (
            <>
                <ItemGroup>
                    <Item
                        testID="connected-services-pools:load-error"
                        title={t('connectedServices.pools.loadError.title')}
                        subtitle={t('connectedServices.pools.loadError.subtitle')}
                        icon={<Icon name="warning" size={ICON_SIZE.md} color={theme.colors.state.danger.foreground} />}
                        mode="info"
                    />
                    {retryRow}
                </ItemGroup>
                {createCard}
            </>
        );
    }

    // `loading` is the only status that has not yet settled on an answer, so it may
    // not claim "no pools" — it says so explicitly, with the same single-row shape
    // the focused pool-detail path uses while its own load is pending.
    if (pools.length === 0 && status === 'loading') {
        return (
            <>
                <ItemGroup>
                    <Item
                        testID="connected-services-pools:loading"
                        title={t('common.loading')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
                {createCard}
            </>
        );
    }

    // Every unsettled status returned above, so an empty list here is an answer.
    if (pools.length === 0) {
        return (
            <>
                <EmptyState
                    testID="connected-services-pools:empty"
                    titleTestID="connected-services-pools:empty:title"
                    icon={<Icon name="stack-simple" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}
                    title={t('connectedServices.pools.empty.title')}
                    subtitle={t('connectedServices.pools.empty.subtitle')}
                />
                {createCard}
            </>
        );
    }

    // Stale data retained after a failed refresh: keep the last-known pool rows and
    // surface an inline retry so the failure stays visible and recoverable.
    const staleErrorBanner = status === 'error' && props.onRetryLoad ? (
        <ItemGroup>
            <Item
                testID="connected-services-pools:stale-error"
                title={t('connectedServices.pools.loadError.staleTitle')}
                subtitle={t('connectedServices.pools.loadError.staleSubtitle')}
                icon={<Icon name="warning" size={ICON_SIZE.md} color={theme.colors.state.warning.foreground} />}
                mode="info"
            />
            <Item
                testID="connected-services-pools:stale-error:retry"
                title={t('connectedServices.pools.loadError.retry')}
                icon={<Icon name="arrow-clockwise" size={ICON_SIZE.md} color={theme.colors.accent.blue} />}
                onPress={props.onRetryLoad}
            />
        </ItemGroup>
    ) : null;

    return (
        <>
            {staleErrorBanner}
            <ItemGroup title={t('connectedServices.pools.title')} columns={2}>
                {pools.map((group) => (
                    <QualifiedPoolRow
                        key={group.ref.groupId}
                        group={group}
                        accountsById={accountsById}
                        accountLabels={accountLabels}
                        serviceLabel={props.serviceLabel}
                        quotaProbesActive={quotaProbesActive}
                        onOpenPool={props.onOpenPool}
                    />
                ))}
            </ItemGroup>
            {createCard}
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    subtitle: {
        marginTop: 5,
        gap: 6,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
    },
    meta: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    metaSeparator: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
    },
}));
