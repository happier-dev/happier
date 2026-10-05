import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    buildQualifiedPluginContributionKey,
    type ConnectedServiceId,
    type ConnectedServiceQuotaRecoveryCreditsV1,
    type ProviderAccountSubscriptionV1,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import { buildQuotaResetRows } from '@/sync/domains/connectedServices/buildQuotaResetRows';
import { presentAccountSubscription } from '@/sync/domains/connectedServices/presentAccountSubscription';
import { resolveQuotaMeterTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { useAllMachines } from '@/sync/store/hooks';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';

import { ACCOUNT_BLOCK_RESET_COUNTDOWN_DAYS_FORMATTER } from './accountBlockFormatters';
import { formatAgentNames } from '../ConnectedServiceMark';
import { projectIndexMeters, type ConnectedAccountIndexMeter } from '../index/ConnectedAccountIndexRow';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { useConnectedAccountSubscription } from '../usage/AccountUsageFacts';
import { useAccountUsageResetAction } from '../usage/useAccountUsageResetAction';
import { useConnectedAccountPinnedMeters } from '../usage/useConnectedAccountPinnedMeters';
import { UsageMeterRow, UsageMeterStack } from '../usage/UsageMeterRow';

/** What the detail's usage sections show (read once for the three of them). */
export type AccountDetailUsageFacts = Readonly<{
    meters: readonly ConnectedAccountIndexMeter[];
    fetchedAt: number | null;
    planLabel: string | null;
    subscription: ProviderAccountSubscriptionV1 | null;
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    loading: boolean;
    error: boolean;
    refreshing: boolean;
    /** Null when the account's service reports no usage (Refresh is not offered). */
    refresh: (() => void) | null;
}>;

/**
 * Account detail · Usage (lab `csvc` D1/D2): every window on the one meter, wide (the reset in and at),
 * with "As of" and Refresh. A signed-out account keeps its last-known usage at full strength with one
 * freshness line; it cannot refresh until it signs in again.
 */
export const AccountDetailUsageSectionView = React.memo(function AccountDetailUsageSectionView(props: Readonly<{
    facts: AccountDetailUsageFacts;
    signedOut: boolean;
    now: number;
    /** Each window can be pinned: pinned windows show as extra gauges beside the composer. */
    pins?: Readonly<{ pinnedMeterIds: readonly string[]; onToggle: (meterId: string) => void }>;
    testID?: string;
    compact?: boolean;
}>) {
    const styles = stylesheet;
    const { facts } = props;
    const testID = props.testID ?? 'account-detail-usage';
    const action = !props.signedOut && (facts.refresh || facts.fetchedAt !== null) ? (
        <View style={styles.headerActions}>
            {facts.fetchedAt !== null ? <SurfaceAsOfLabel at={facts.fetchedAt} testID={`${testID}:as-of`} /> : null}
            {!props.compact && facts.refresh ? <RoundButton
                testID={`${testID}:refresh`}
                size="small"
                display="inverted"
                title={t('common.refresh')}
                leading={<Icon name="arrow-clockwise" size={14} />}
                loading={facts.refreshing}
                disabled={facts.refreshing}
                onPress={facts.refresh}
            /> : null}
        </View>
    ) : undefined;
    return (
        <ItemGroup title={t('settings.usage')} action={action} headerStyle={{ alignItems: 'center' }}>
            {props.signedOut && facts.fetchedAt !== null ? (
                <SectionContentRow>
                    <SurfaceFreshnessLine
                        testID={`${testID}:stale`}
                        reason={t('connectedServicesSettings.detailUsageSignedOutAt', { time: formatAsOfTime(facts.fetchedAt, props.now) })}
                    />
                </SectionContentRow>
            ) : null}
            {facts.meters.length > 0 ? (
                <SectionContentRow testID={`${testID}:meters`}>
                    <UsageMeterStack>
                        {facts.meters.map((meter) => {
                            const row = (
                                <UsageMeterRow
                                    key={meter.meterId}
                                    testID={`${testID}:meter:${meter.meterId}`}
                                    label={meter.label}
                                    remainingPct={meter.remainingPct}
                                    resetsAt={meter.resetsAt}
                                    tone={resolveQuotaMeterTone(meter)}
                                    estimated={meter.status === 'estimated'}
                                    size="wide"
                                    now={props.now}
                                />
                            );
                            const pins = props.pins;
                            if (!pins) return row;
                            const pinned = pins.pinnedMeterIds.includes(meter.meterId);
                            const pinLabel = t('connectedServicesSettings.usageWindowPin', { meter: meter.label });
                            return (
                                <View key={meter.meterId} style={styles.pinnableMeter}>
                                    <View style={styles.pinnableMeterRow}>{row}</View>
                                    <IconButton
                                        testID={`${testID}:pin:${meter.meterId}`}
                                        iconName="push-pin"
                                        size={24}
                                        iconSize={14}
                                        variant="plain"
                                        selected={pinned}
                                        accessibilityLabel={pinLabel}
                                        tooltip={pinLabel}
                                        onPress={() => pins.onToggle(meter.meterId)}
                                    />
                                </View>
                            );
                        })}
                    </UsageMeterStack>
                </SectionContentRow>
            ) : facts.loading ? (
                <SurfaceStateCard testID={`${testID}:loading`} size="line" kind="loading" title={t('common.loading')} />
            ) : facts.error ? (
                <SurfaceStateCard
                    testID={`${testID}:error`}
                    size="line"
                    kind="error"
                    title={t('connectedServicesSettings.usageReadFailed')}
                    action={facts.refresh ? { label: t('common.retry'), onPress: facts.refresh } : undefined}
                />
            ) : (
                <SurfaceStateCard
                    testID={`${testID}:none`}
                    size="line"
                    kind="empty"
                    title={t('connectedServicesSettings.noLimitsBilledPerUse')}
                />
            )}
        </ItemGroup>
    );
});

/**
 * Account detail · Subscription (lab `csvc` D1/D2): the plan, when it renews or ends, and when that was
 * checked. Rendered only when the provider reported a subscription (never inferred).
 */
export const AccountDetailSubscriptionSectionView = React.memo(function AccountDetailSubscriptionSectionView(props: Readonly<{
    subscription: ProviderAccountSubscriptionV1 | null;
    serviceLabel: string;
    planLabel: string | null;
    now: number;
    testID?: string;
    compact?: boolean;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const presented = presentAccountSubscription(props.subscription, props.now);
    if (!presented) return null;
    const testID = props.testID ?? 'account-detail-subscription';
    const ends = presented.endsAtMs === null ? null : new Date(presented.endsAtMs).toLocaleDateString([], { day: 'numeric', month: 'short' });
    const days = presented.days ?? 0;
    const subtitle = presented.state === 'none'
        ? t('connectedServicesCollection.subscriptionNone')
        : presented.state === 'renews'
            ? t('connectedServicesCollection.subscriptionRenewsOn', { date: ends ?? '', days })
            : presented.state === 'ends'
                ? t('connectedServicesCollection.subscriptionEndsOn', { date: ends ?? '', days })
                : t('connectedServicesCollection.subscriptionPeriodEndsOn', { date: ends ?? '', days });
    const checked = (
        <View style={styles.checked}>
            {!props.compact ? <Icon name="clock" size={12} color={presented.stale ? theme.colors.state.warning.foreground : theme.colors.text.tertiary} /> : null}
            <Text style={[styles.checkedText, presented.stale ? styles.warning : null]}>
                {presented.stale
                    ? t('connectedServicesCollection.checkedMayBeOutOfDate', { time: formatAsOfTime(presented.checkedAtMs, props.now) })
                    : t('connectedServicesCollection.checkedAt', { time: formatAsOfTime(presented.checkedAtMs, props.now) })}
            </Text>
        </View>
    );
    if (props.compact) {
        const summary = presented.state === 'none' ? t('connectedServicesCollection.subscriptionNone')
            : presented.state === 'renews' ? `${[props.serviceLabel, props.planLabel].filter(Boolean).join(' ')} · ${t('connectedServicesCollection.subscriptionRenewsIn', { days })}`
            : presented.state === 'ends' ? t('connectedServicesCollection.subscriptionEndsIn', { days })
            : t('connectedServicesCollection.subscriptionPeriodEndsIn', { days });
        return <ItemGroup><Item testID={testID} density="compact" title={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <StatusDot color={presented.state === 'ends' ? theme.colors.state.warning.foreground : presented.state === 'renews' ? theme.colors.state.success.foreground : theme.colors.text.tertiary} />
            <Text style={[styles.compactSubscription, presented.state === 'ends' ? styles.warning : null]}>{summary}</Text>
        </View>} mode="info" showChevron={false} rightElement={checked} /></ItemGroup>;
    }
    return (
        <ItemGroup title={t('connectedServicesCollection.subscriptionTitle')} action={checked}>
            <Item
                testID={testID}
                title={[props.serviceLabel, props.planLabel].filter(Boolean).join(' ')}
                subtitle={subtitle}
                subtitleLines={0}
                mode="info"
                showChevron={false}
                rightElement={presented.state === 'none' ? undefined : (
                    <StatusPill
                        testID={`${testID}:renewal`}
                        variant={presented.state === 'ends' ? 'warning' : presented.state === 'renews' ? 'success' : 'neutral'}
                        label={presented.state === 'ends'
                            ? t('connectedServicesCollection.renewalOff')
                            : presented.state === 'renews' ? t('connectedServicesCollection.renewalOn') : t('connectedServicesCollection.renewalUnknown')}
                    />
                )}
            />
        </ItemGroup>
    );
});

/** The account facts' responsive composition, shared by live detail and the specimen fixture. */
export const AccountDetailFactsSectionsView = React.memo(function AccountDetailFactsSectionsView(props: Readonly<{
    facts: AccountDetailUsageFacts;
    serviceLabel: string;
    signedOut: boolean;
    now: number;
    pins?: React.ComponentProps<typeof AccountDetailUsageSectionView>['pins'];
    resetsSection?: React.ReactNode;
}>) {
    const [compact, setCompact] = React.useState(false);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (Number.isFinite(width) && width > 0) setCompact(width < PAGE_LIST_METRICS.rowStackBelowWidthPx);
    }, []);
    const subscription = <AccountDetailSubscriptionSectionView key="subscription" subscription={props.facts.subscription} serviceLabel={props.serviceLabel} planLabel={props.facts.planLabel} now={props.now} compact={compact} />;
    const usage = <AccountDetailUsageSectionView key="usage" facts={props.facts} signedOut={props.signedOut} now={props.now} pins={props.pins} compact={compact} />;
    return <View onLayout={onLayout}>{compact ? [subscription, usage] : [usage, subscription]}{props.resetsSection}</View>;
});

/**
 * Account detail · Usage resets (lab `csvc` D1): each available reset with when it expires and Use. Each
 * starts a fresh window at once through the one consume operation.
 */
export const AccountDetailResetsSectionView = React.memo(function AccountDetailResetsSectionView(props: Readonly<{
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    now: number;
    pending: boolean;
    onUse: ((providerCreditId: string | null) => void) | null;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const rows = buildQuotaResetRows(props.recoveryCredits, props.now, ACCOUNT_BLOCK_RESET_COUNTDOWN_DAYS_FORMATTER);
    if (rows.length === 0) return null;
    const testID = props.testID ?? 'account-detail-resets';
    return (
        <ItemGroup
            title={t('connectedServicesCollection.usageResetsTitle')}
            description={t('connectedServicesCollection.usageResetsDescription')}
        >
            {rows.map((row) => {
                const expires = row.expiresAtMs === null ? null : new Date(row.expiresAtMs).toLocaleDateString([], { day: 'numeric', month: 'short' });
                return (
                    <Item
                        key={row.key}
                        testID={`${testID}:${row.key}`}
                        title={t('connectedServicesCollection.usageResetTitle')}
                        subtitle={expires
                            ? [t('connectedServicesCollection.usageResetExpiresOn', { date: expires }), row.countdownLabel].filter(Boolean).join(' · ')
                            : undefined}
                        icon={<Icon name="clock-counter-clockwise" size={17} color={theme.colors.text.secondary} />}
                        mode="info"
                        showChevron={false}
                        rightElement={props.onUse && row.canUse ? (
                            <RoundButton
                                testID={`${testID}:${row.key}:use`}
                                size="small"
                                display="secondary"
                                title={t('connectedServicesCollection.use')}
                                loading={props.pending}
                                disabled={props.pending}
                                onPress={() => props.onUse?.(row.consumableCreditId)}
                            />
                        ) : undefined}
                        rightElementOutsidePressable
                    />
                );
            })}
        </ItemGroup>
    );
});

/** The live usage, subscription and resets of an account: one quota read, one usage-record read. */
export const AccountDetailFactsSections = React.memo(function AccountDetailFactsSections(props: Readonly<{
    account: QualifiedConnectedAccountRef;
    legacyServiceId: ConnectedServiceId | null;
    serviceLabel: string;
    signedOut: boolean;
}>) {
    const quota = useQualifiedConnectedAccountQuota(props.account);
    const subscription = useConnectedAccountSubscription(quota.usageRecordId);
    const pins = useConnectedAccountPinnedMeters({ account: props.account, legacyServiceId: props.legacyServiceId });
    const refresh = quota.refresh;
    const retry = React.useCallback(() => { void refresh(); }, [refresh]);
    const snapshot = quota.snapshot;
    const facts: AccountDetailUsageFacts = {
        meters: snapshot ? projectIndexMeters(snapshot.meters) : [],
        fetchedAt: snapshot?.fetchedAt ?? null,
        planLabel: snapshot?.planLabel ?? null,
        subscription,
        recoveryCredits: snapshot?.recoveryCredits ?? null,
        loading: quota.loading,
        error: quota.error !== null,
        refreshing: quota.refreshing,
        refresh: quota.supported === false ? null : retry,
    };
    const now = Date.now();
    return (
        <AccountDetailFactsSectionsView facts={facts} serviceLabel={props.serviceLabel} signedOut={props.signedOut} now={now} pins={pins} resetsSection={props.legacyServiceId && !props.signedOut ? (
                <LiveResetsSection
                    legacyServiceId={props.legacyServiceId}
                    accountId={props.account.accountId}
                    recoveryCredits={facts.recoveryCredits}
                    fetchedAt={facts.fetchedAt}
                    onApplied={retry}
                    now={now}
                />
            ) : null} />
    );
});

const LiveResetsSection = React.memo(function LiveResetsSection(props: Readonly<{
    legacyServiceId: ConnectedServiceId;
    accountId: string;
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    fetchedAt: number | null;
    onApplied: () => void;
    now: number;
}>) {
    const action = useAccountUsageResetAction({
        legacyServiceId: props.legacyServiceId,
        accountId: props.accountId,
        snapshotFetchedAtMs: props.fetchedAt,
        onApplied: props.onApplied,
    });
    return (
        <AccountDetailResetsSectionView
            recoveryCredits={props.recoveryCredits}
            now={props.now}
            pending={action.pending}
            onUse={(creditId) => { void action.use(creditId); }}
        />
    );
});

/** One agent that signs in with this account: directly (its default) or through a pool. */
export type AccountDetailUsedByRow = Readonly<{
    key: string;
    agentId: string | null;
    title: string;
    subtitle: string;
    /** The subtitle leads with ★ (this account is the agent's default). */
    isDefault: boolean;
    onPress?: () => void;
}>;

/**
 * Account detail · Used by (lab `csvc` D1): the agents that sign in with this account now — as their
 * default, or through a pool (and whether it is in use now) — and those that could.
 */
export const AccountDetailUsedBySectionView = React.memo(function AccountDetailUsedBySectionView(props: Readonly<{
    rows: readonly AccountDetailUsedByRow[];
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    if (props.rows.length === 0) return null;
    const testID = props.testID ?? 'account-detail-used-by';
    return (
        <ItemGroup title={t('connectedServicesSettings.detailUsedByTitle')}>
            {props.rows.map((row) => (
                <Item
                    key={row.key}
                    testID={`${testID}:${row.key}`}
                    title={row.title}
                    subtitle={row.subtitle}
                    subtitleLeading={row.isDefault
                        ? <Icon name="star" weight="fill" size={11} color={theme.colors.text.secondary} />
                        : undefined}
                    icon={row.agentId ? <AgentIcon agentId={row.agentId} size={17} /> : undefined}
                    showChevron={row.onPress !== undefined}
                    mode={row.onPress ? 'interactive' : 'info'}
                    onPress={row.onPress}
                />
            ))}
        </ItemGroup>
    );
});

/** The live Used by rows, from the one Connected services index. */
export const AccountDetailUsedBySection = React.memo(function AccountDetailUsedBySection(props: Readonly<{
    account: QualifiedConnectedAccountRef;
    testID?: string;
}>) {
    const router = useRouter();
    const { indexModel } = useConnectedServicesIndex({ agents: 'cached' });
    const serviceKey = buildQualifiedPluginContributionKey(props.account.service);
    const sheet = indexModel.sheets.find((candidate) => candidate.serviceKey === serviceKey);
    if (!sheet || sheet.usedBy.length === 0) return null;
    const agentIdByTitle = new Map(sheet.usedBy.map((title, index) => [title, sheet.usedByAgentIds[index] ?? null]));
    const roles = sheet.rolesByAccountId[props.account.accountId];
    const direct = new Set(roles?.defaultFor ?? []);
    const throughPools = (roles?.pools ?? []).flatMap((membership) => {
        const pool = sheet.pools.find((candidate) => candidate.ref.groupId === membership.groupId);
        return (pool?.defaultFor ?? []).map((agent) => ({ agent, pool, inUse: membership.inUse }));
    });
    const using = new Set([...direct, ...throughPools.map((entry) => entry.agent)]);
    const others = sheet.usedBy.filter((agent) => !using.has(agent));
    const openAgent = (agentId: string | null) => agentId ? () => router.push(`/settings/agents/${agentId}` as never) : undefined;
    const rows: AccountDetailUsedByRow[] = [
        ...[...direct].map((agent) => ({
            key: `direct:${agent}`,
            agentId: agentIdByTitle.get(agent) ?? null,
            title: agent,
            subtitle: t('connectedServicesCollection.usedByDefault'),
            isDefault: true,
            onPress: openAgent(agentIdByTitle.get(agent) ?? null),
        })),
        ...throughPools.filter((entry) => !direct.has(entry.agent)).map((entry) => {
            const pool = entry.pool?.displayName ?? entry.pool?.ref.groupId ?? '';
            return {
                key: `pool:${entry.agent}`,
                agentId: agentIdByTitle.get(entry.agent) ?? null,
                title: entry.agent,
                subtitle: entry.inUse
                    ? t('connectedServicesSettings.detailUsedByPoolInUse', { pool })
                    : t('connectedServicesSettings.detailUsedByPool', { pool }),
                isDefault: false,
                onPress: openAgent(agentIdByTitle.get(entry.agent) ?? null),
            };
        }),
        ...(others.length > 0 ? [{
            key: 'others',
            agentId: null,
            title: formatAgentNames(others),
            subtitle: t('connectedServicesSettings.detailUsedByCould'),
            isDefault: false,
        }] : []),
    ];
    return <AccountDetailUsedBySectionView rows={rows} testID={props.testID} />;
});

/** One machine the account works on, with its presence. */
export type AccountDetailMachine = Readonly<{ id: string; name: string; online: boolean }>;

/**
 * Account detail · Works on (G10): the account is saved to the Account, so every machine can use it
 * when a session starts there; nothing is copied ahead of time. Each machine with its presence.
 */
export const AccountDetailWorksOnSectionView = React.memo(function AccountDetailWorksOnSectionView(props: Readonly<{
    machines: readonly AccountDetailMachine[];
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const testID = props.testID ?? 'account-detail-works-on';
    if (props.machines.length === 0) return null;
    return (
        <ItemGroup
            title={t('connectedServicesSettings.detailWorksOnTitle')}
            description={t('connectedServicesSettings.detailWorksOnDescription')}
            surface="none"
        >
            <View style={styles.machines} testID={testID}>
                {props.machines.map((machine) => (
                    <View key={machine.id} style={[styles.machine, machine.online ? null : styles.machineOffline]}>
                        <Icon name="desktop" size={13} color={theme.colors.text.secondary} />
                        <Text style={styles.machineName} numberOfLines={1}>{machine.name}</Text>
                        <StatusDot
                            size={6}
                            color={machine.online ? theme.colors.state.success.foreground : theme.colors.text.tertiary}
                            accessibilityLabel={machine.online ? t('status.online') : t('status.offline')}
                        />
                    </View>
                ))}
            </View>
        </ItemGroup>
    );
});

export const AccountDetailWorksOnSection = React.memo(function AccountDetailWorksOnSection(props: Readonly<{ testID?: string }>) {
    const machines = useAllMachines();
    const rows = React.useMemo(() => machines.map((machine) => ({
        id: machine.id,
        name: getMachineDisplayName(machine),
        online: isMachineOnline(machine),
    })), [machines]);
    return <AccountDetailWorksOnSectionView machines={rows} testID={props.testID} />;
});

const stylesheet = StyleSheet.create((theme) => ({
    compactSubscription: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.text.primary, flexShrink: 1 },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    checked: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    checkedText: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.tertiary,
    },
    warning: {
        color: theme.colors.state.warning.foreground,
    },
    machines: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    machine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 8,
        paddingRight: 9,
        height: 26,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    machineOffline: {
        opacity: 0.7,
    },
    pinnableMeter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    pinnableMeterRow: {
        flex: 1,
        minWidth: 0,
    },
    machineName: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.primary,
    },
}));
