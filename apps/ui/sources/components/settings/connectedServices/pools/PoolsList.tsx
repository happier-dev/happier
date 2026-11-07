import * as React from 'react';
import { View } from 'react-native';
import * as ReactNavigation from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useConnectedServiceQuotaSnapshot } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot';
import {
    type ConnectedServiceQuotaGaugeLabelFormatter,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { deriveAccountHealth, type AccountHealth } from '@/sync/domains/connectedServices/deriveAccountHealth';
import { projectConnectedServiceQuotaSnapshotForLimitSelection } from '@/sync/domains/connectedServices/projectConnectedServiceQuotaSnapshotForLimitSelection';
import type {
    ConnectedServiceAuthGroupQuotaLimitSelectionV1,
    ConnectedServiceId,
} from '@happier-dev/protocol';
import { t } from '@/text';

import { ConnectedServiceCapacityAvatar, CONNECTED_SERVICE_GAUGE_BOX } from '../ConnectedServiceCapacityAvatar';
import { Icon } from '@/components/ui/icons/Icon';
import {
    resolveAccountCapacityView,
    type CapacityRingDatum,
} from '../account/accountBlockModel';
import {
    parseConnectedServiceGroupViewModels,
    resolveConnectedServiceGroupMemberCredentialHealthStatus,
    resolveConnectedServiceGroupProfileTitle,
    resolveConnectedServiceGroupStrategyLabel,
    type ConnectedServiceGroupMemberViewModel,
    type ConnectedServiceGroupProfileLike,
    type ConnectedServiceGroupViewModel,
} from '../model/connectedServiceGroupViewModel';
import {
    readConnectedServiceAuthGroupsLoadStatus,
    type ConnectedServiceAuthGroupsLoadStatus,
} from '../model/useConnectedServiceAuthGroups';

/** Ring-avatar footprint for the row leading element. */
const POOL_AVATAR_SIZE = 42;

/**
 * The gauge view-model is the canonical "snapshot → meter rows" owner. Capacity
 * derivation reads only the numeric `remainingPct` from those rows, so the label
 * strings are never surfaced here and a no-op formatter is correct.
 */
const NOOP_GAUGE_LABEL_FORMATTER: ConnectedServiceQuotaGaugeLabelFormatter = {
    unavailable: () => '',
    remaining: () => '',
    remainingWithReset: () => '',
    used: () => '',
    durationNow: () => '',
    durationOutdated: () => '',
    durationDaysHours: () => '',
    durationHoursMinutes: () => '',
    durationMinutes: () => '',
    durationHoursMinutesSeconds: () => '',
    durationMinutesSeconds: () => '',
    subscriptionEnds: () => '',
    subscriptionEndsInDays: () => '',
    subscriptionRenews: () => '',
    subscriptionRenewsInDays: () => '',
};

const HEALTH_SEVERITY_RANK: Readonly<Record<AccountHealth, number>> = {
    healthy: 0,
    attention: 1,
    error: 2,
};

function worstAccountHealth(values: ReadonlyArray<AccountHealth>): AccountHealth {
    return values.reduce<AccountHealth>(
        (worst, value) => (HEALTH_SEVERITY_RANK[value] > HEALTH_SEVERITY_RANK[worst] ? value : worst),
        'healthy',
    );
}

function healthToStateVariant(health: AccountHealth): 'success' | 'warning' | 'danger' {
    if (health === 'error') return 'danger';
    if (health === 'attention') return 'warning';
    return 'success';
}

function usePoolsScreenIsFocused(): boolean {
    const useIsFocused = (ReactNavigation as { useIsFocused?: () => boolean }).useIsFocused;
    return typeof useIsFocused === 'function' ? useIsFocused() : true;
}

export type SnapshotGauge = Readonly<{ capacityPct: number | null; rings: CapacityRingDatum[] }>;

/**
 * Project account capacity ONCE from a snapshot and return both the overall
 * capacity (min remaining % across comparable meters) and the concentric rings
 * (one per limit, most-constrained outermost). A single pass keeps the row gauge
 * and the center % from ever drifting.
 */
function deriveSnapshotGauge(
    snapshot: ReturnType<typeof useConnectedServiceQuotaSnapshot>['snapshot'],
): SnapshotGauge {
    if (!snapshot) return { capacityPct: null, rings: [] };
    return resolveAccountCapacityView(snapshot.meters, snapshot.fetchedAt, NOOP_GAUGE_LABEL_FORMATTER);
}

export type PoolMemberResolution = Readonly<{
    health: AccountHealth;
    capacityPct: number | null;
    rings: CapacityRingDatum[];
}>;

/** Stable structural key for a ring set (order-sensitive); used for render-loop dedup. */
function ringsKeyOf(rings: ReadonlyArray<CapacityRingDatum>): string {
    return rings.map((ring) => `${ring.ratio}:${ring.tone}`).join('|');
}

/**
 * Headless per-member probe: subscribes to the shared quota snapshot, derives the
 * member's capacity + rings + health once, and reports it up. Rendering one probe
 * per member keeps the snapshot hook call count fixed per component instance (Rules
 * of Hooks) while letting the row aggregate warnings across a dynamic member set.
 */
const PoolMemberProbe = React.memo(function PoolMemberProbe(props: Readonly<{
    serviceId: ConnectedServiceId;
    member: ConnectedServiceGroupMemberViewModel;
    profiles: ReadonlyArray<ConnectedServiceGroupProfileLike>;
    quotaLimitSelection?: ConnectedServiceAuthGroupQuotaLimitSelectionV1;
    onResolve: (profileId: string, resolution: PoolMemberResolution) => void;
}>) {
    const { serviceId, member, onResolve } = props;
    const memberHealthStatus = resolveConnectedServiceGroupMemberCredentialHealthStatus({
        member,
        profiles: props.profiles,
    });
    const { snapshot, isStale } = useConnectedServiceQuotaSnapshot({
        serviceId,
        profileId: member.profileId,
        credentialHealthStatus: memberHealthStatus,
    });

    const displaySnapshot = React.useMemo(
        () => projectConnectedServiceQuotaSnapshotForLimitSelection(snapshot, props.quotaLimitSelection),
        [props.quotaLimitSelection, snapshot],
    );
    const gauge = React.useMemo(() => deriveSnapshotGauge(displaySnapshot), [displaySnapshot]);
    const { capacityPct, rings } = gauge;
    const health = deriveAccountHealth({
        status: memberHealthStatus,
        capacityPct,
        isStale,
    });

    // `rings` is a fresh array every render; key on its stable structural digest so
    // an unchanged ring set never re-fires the report effect (render-loop safety).
    const ringsKey = ringsKeyOf(rings);
    const profileId = member.profileId;
    React.useEffect(() => {
        onResolve(profileId, { health, capacityPct, rings });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `ringsKey` stands in for the fresh `rings` array.
    }, [onResolve, profileId, health, capacityPct, ringsKey]);

    return null;
});

const PoolRow = React.memo(function PoolRow(props: Readonly<{
    serviceId: ConnectedServiceId;
    group: ConnectedServiceGroupViewModel;
    profiles: ReadonlyArray<ConnectedServiceGroupProfileLike>;
    profileLabelsByKey: Readonly<Record<string, string>>;
    quotaProbesActive: boolean;
    onOpenPool: (groupId: string) => void;
    /** Injected by {@link ItemGroup}'s divider distribution; forwarded to the row Item. */
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { group, serviceId } = props;
    const rowTestId = `connected-services-pool:${group.groupId}`;

    const [resolutions, setResolutions] = React.useState<Readonly<Record<string, PoolMemberResolution>>>({});
    const onResolve = React.useCallback((profileId: string, resolution: PoolMemberResolution) => {
        setResolutions((prev) => {
            const existing = prev[profileId];
            if (
                existing
                && existing.health === resolution.health
                && existing.capacityPct === resolution.capacityPct
                && ringsKeyOf(existing.rings) === ringsKeyOf(resolution.rings)
            ) {
                return prev;
            }
            return { ...prev, [profileId]: resolution };
        });
    }, []);

    const enabledMembers = React.useMemo(() => group.members.filter((member) => member.enabled), [group.members]);
    const warningCount = enabledMembers.reduce((count, member) => {
        const health = resolutions[member.profileId]?.health;
        return health === 'attention' || health === 'error' ? count + 1 : count;
    }, 0);
    const aggregateHealth = worstAccountHealth(
        enabledMembers.map((member) => resolutions[member.profileId]?.health ?? 'healthy'),
    );
    const activeCapacityPct = group.activeProfileId
        ? resolutions[group.activeProfileId]?.capacityPct ?? null
        : null;

    const activeTitle = group.activeProfileId
        ? resolveConnectedServiceGroupProfileTitle({
            serviceId,
            profileId: group.activeProfileId,
            labelsByKey: props.profileLabelsByKey,
            profiles: props.profiles,
        })
        : null;

    const strategyLabel = resolveConnectedServiceGroupStrategyLabel(group.policy.strategy);

    const warningVariant = healthToStateVariant(aggregateHealth);

    const activeRings = group.activeProfileId
        ? resolutions[group.activeProfileId]?.rings ?? []
        : [];

    const leadingIcon = (
        <ConnectedServiceCapacityAvatar
            testID={`${rowTestId}:avatar`}
            rings={activeRings}
            centerLabel={activeCapacityPct != null ? String(Math.round(activeCapacityPct)) : null}
            size={POOL_AVATAR_SIZE}
            accessibilityLabel={group.label}
        />
    );

    const titleNode = (
        <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>{group.label}</Text>
            <StatusPill
                testID={`${rowTestId}:mode`}
                variant={group.policy.autoSwitch ? 'info' : 'neutral'}
                hideDot
                label={group.policy.autoSwitch
                    ? t('connectedServices.pools.autoBadge')
                    : t('connectedServices.pools.manualBadge')}
            />
            {warningCount > 0 ? (
                <View
                    testID={`${rowTestId}:warnings`}
                    style={[styles.warningChip, { backgroundColor: theme.colors.state[warningVariant].background }]}
                    accessibilityLabel={t('connectedServices.pools.memberWarningsA11y', { count: warningCount })}
                >
                    <Icon
                        name="warning"
                        size={14}
                        color={theme.colors.state[warningVariant].foreground}
                    />
                    <Text
                        testID={`${rowTestId}:warnings:count`}
                        style={[styles.warningCount, { color: theme.colors.state[warningVariant].foreground }]}
                    >
                        {warningCount}
                    </Text>
                </View>
            ) : null}
        </View>
    );

    const subtitleNode = (
        <View style={styles.subtitle}>
            <View style={styles.metaRow}>
                {activeTitle ? (
                    <>
                        <Text style={styles.meta} numberOfLines={1}>{activeTitle}</Text>
                        <Text style={styles.metaSeparator}> · </Text>
                    </>
                ) : null}
                <Text style={styles.meta}>
                    {t('connectedServices.detail.groups.enabledMembers', {
                        enabled: enabledMembers.length,
                        total: group.members.length,
                    })}
                </Text>
                <Text style={styles.metaSeparator}> · </Text>
                <Text testID={`${rowTestId}:strategy`} style={styles.meta}>{strategyLabel}</Text>
            </View>
            {props.quotaProbesActive
                ? group.members.map((member) => (
                    <PoolMemberProbe
                        key={member.profileId}
                        serviceId={serviceId}
                        member={member}
                        profiles={props.profiles}
                        quotaLimitSelection={group.policy.quotaLimitSelection}
                        onResolve={onResolve}
                    />
                ))
                : null}
        </View>
    );

    return (
        <Item
            testID={rowTestId}
            title={titleNode}
            subtitle={subtitleNode}
            subtitleLines={0}
            leftElement={leadingIcon}
            iconBoxSize={CONNECTED_SERVICE_GAUGE_BOX}
            onPress={() => props.onOpenPool(group.groupId)}
            showDivider={props.showDivider}
        />
    );
});

export type PoolsListProps = Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<ConnectedServiceGroupProfileLike>;
    profileLabelsByKey: Readonly<Record<string, string>>;
    /** Authoritative groups (raw wire shape) — parsed via the shared group view-model. */
    groups: unknown;
    loadStatus?: ConnectedServiceAuthGroupsLoadStatus;
    quotasEnabled: boolean;
    groupConfigurationSupported: boolean;
    onOpenPool: (groupId: string) => void;
    onCreatePool: () => void;
    /** Refetch the authoritative pools after a load failure (the error/stale retry action). */
    onRetryLoad?: () => void;
}>;

/**
 * Pools tab list: one drill-in row per auth group ("pool"), an under-the-list
 * "Create pool" action card, and an empty state when no pools exist. Reuses the
 * canonical group view-model read path; wire symbols stay `group`/`AuthGroup`.
 */
export const PoolsList = React.memo(function PoolsList(props: PoolsListProps) {
    const { theme } = useUnistyles();
    const isFocused = usePoolsScreenIsFocused();
    const quotaProbesActive = props.quotasEnabled && isFocused;
    const pools = React.useMemo(
        () => parseConnectedServiceGroupViewModels(props.groups),
        [props.groups],
    );
    const loadStatus = props.loadStatus ?? readConnectedServiceAuthGroupsLoadStatus(props.groups);

    const createCard = (
        <ItemGroup>
            <Item
                testID="connected-services-pool-action:create"
                title={t('connectedServices.pools.create.title')}
                subtitle={props.groupConfigurationSupported
                    ? t('connectedServices.pools.create.subtitle')
                    : t('connectedServices.detail.groupActions.runtimeFallbackUnsupported')}
                icon={<Icon name="plus-circle" size={20} color={theme.colors.accent.blue} />}
                disabled={!props.groupConfigurationSupported}
                onPress={props.groupConfigurationSupported ? props.onCreatePool : undefined}
            />
        </ItemGroup>
    );

    const retryCard = props.onRetryLoad ? (
        <Item
            testID="connected-services-pools:load-error:retry"
            title={t('connectedServices.pools.loadError.retry')}
            icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.accent.blue} />}
            onPress={props.onRetryLoad}
        />
    ) : null;

    // A failed load with NO data to fall back on gets an explicit, actionable error
    // state — never the "No pools yet" empty state, which would silently mask the failure.
    if (pools.length === 0 && loadStatus === 'error') {
        return (
            <>
                <ItemGroup>
                    <Item
                        testID="connected-services-pools:load-error"
                        title={t('connectedServices.pools.loadError.title')}
                        subtitle={t('connectedServices.pools.loadError.subtitle')}
                        icon={<Icon name="warning" size={20} color={theme.colors.state.danger.foreground} />}
                        showChevron={false}
                    />
                    {retryCard}
                </ItemGroup>
                {createCard}
            </>
        );
    }

    const canShowAuthoritativeEmpty = loadStatus == null
        || loadStatus === 'idle'
        || loadStatus === 'loaded';

    if (pools.length === 0 && canShowAuthoritativeEmpty) {
        return (
            <>
                <EmptyState
                    testID="connected-services-pools:empty"
                    titleTestID="connected-services-pools:empty:title"
                    icon={<Icon name="stack-simple" size={29} color={theme.colors.text.secondary} />}
                    title={t('connectedServices.pools.empty.title')}
                    subtitle={t('connectedServices.pools.empty.subtitle')}
                />
                {createCard}
            </>
        );
    }

    // Stale data retained after a failed refresh: keep the last-known pool rows and
    // surface an inline retry so the failure stays visible and recoverable.
    const staleErrorBanner = loadStatus === 'error' && props.onRetryLoad ? (
        <ItemGroup>
            <Item
                testID="connected-services-pools:stale-error"
                title={t('connectedServices.pools.loadError.staleTitle')}
                subtitle={t('connectedServices.pools.loadError.staleSubtitle')}
                icon={<Icon name="warning" size={20} color={theme.colors.state.warning.foreground} />}
                showChevron={false}
            />
            <Item
                testID="connected-services-pools:stale-error:retry"
                title={t('connectedServices.pools.loadError.retry')}
                icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.accent.blue} />}
                onPress={props.onRetryLoad}
            />
        </ItemGroup>
    ) : null;

    return (
        <>
            {staleErrorBanner}
            <ItemGroup title={t('connectedServices.pools.title')} columns={2}>
                {pools.map((group) => (
                    <PoolRow
                        key={group.groupId}
                        serviceId={props.serviceId}
                        group={group}
                        profiles={props.profiles}
                        profileLabelsByKey={props.profileLabelsByKey}
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
    warningChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 999,
    },
    warningCount: {
        ...Typography.pillLabel(),
        ...Typography.tabular(),
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
