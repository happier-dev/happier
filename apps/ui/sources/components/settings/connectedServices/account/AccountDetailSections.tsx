import { presentConnectedServiceQuotaFreshness } from '@/sync/domains/connectedServices/presentConnectedServiceQuotaFreshness';
import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceQuotaMeterV1, ConnectedServiceQuotaRecoveryCreditsV1, ConnectedServiceQuotaRecoveryCreditDetailsByIdV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol/connect/accountSubscription';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
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
import { formatConnectedServiceQuotaReportedAmount } from '@/sync/domains/connectedServices/accountUsage/formatProviderUsageAmount';
import { useActiveServerAccountScope, useMachineDisplayById, useActiveMachineFacts } from '@/sync/store/hooks';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineUtils';
import { isMachineDisplayNamePending } from '@/utils/sessions/machineDisplayNames';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { describeMachinePresenceLine } from '@/utils/sessions/machinePresenceLine';

import { ACCOUNT_BLOCK_RESET_COUNTDOWN_DAYS_FORMATTER } from './accountBlockFormatters';
import { resolveResetLimitLabels } from './accountBlockModel';
import { formatAgentNames } from '../ConnectedServiceMark';
import { projectIndexMeters, type ConnectedAccountIndexMeter } from '../index/projectIndexMeters';
import { isConnectedAccountQuotaCreditsOnly } from '../pools/derivePoolUsage';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import type { ConnectedAccountAccessMode } from '../model/presentConnectedAccountAccessMode';
import { projectConnectedAccountSubscriptionFacts } from '../model/resolveConnectedAccountAccessMode';
import { useConnectedAccountSubscription } from '../usage/AccountUsageFacts';
import { useAccountUsageResetAction } from '../usage/useAccountUsageResetAction';
import { useConnectedAccountPinnedMeters } from '../usage/useConnectedAccountPinnedMeters';
import { UsageMeterRow, UsageMeterStack } from '../usage/UsageMeterRow';
import { UsageRefreshAction } from '../usage/UsageRefreshAction';

const EMPTY_LIMIT_METERS: readonly ConnectedServiceQuotaMeterV1[] = [];

/** What the detail's usage sections show (read once for the three of them). */
export type AccountDetailUsageFacts = Readonly<{
    meters: readonly ConnectedAccountIndexMeter[];
    fetchedAt: number | null;
    planLabel: string | null;
    subscription: ProviderAccountSubscriptionV1 | null;
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    recoveryCreditDetails?: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1;
    /** Raw snapshot meters, so a reset can name the limits it clears. */
    limitMeters?: readonly ConnectedServiceQuotaMeterV1[];
    loading: boolean;
    error: string | null;
    refreshing: boolean;
    /** Null when there is no refresh target for this account. */
    refresh: (() => void) | null;
    usageState?: 'not_loaded' | 'observed';
    /** Included limits spent while provider credits keep the account usable. */
    creditsOnly?: boolean;
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
    /** A key has no allowance: with no reported meters its Usage says so in one row (lab `muse-accounts` A1). */
    accessMode?: ConnectedAccountAccessMode | null;
    testID?: string;
    compact?: boolean;
}>) {
    const styles = stylesheet;
    const { facts } = props;
    const testID = props.testID ?? 'account-detail-usage';
    const { fetchedAt } = presentConnectedServiceQuotaFreshness({ state: facts.usageState, fetchedAt: facts.fetchedAt }, props.now);
    // Signed out says one thing: the page's signed-out state and Sign in. A refresh failure from before it is stale.
    const failure = props.signedOut ? null : facts.error;
    const action = !props.signedOut && (facts.refresh || fetchedAt !== null) ? (
        <UsageRefreshAction testID={testID} fetchedAt={fetchedAt}
            refresh={props.compact ? null : facts.refresh} refreshing={facts.refreshing} />
    ) : undefined;
    return (
        <ItemGroup title={t('settings.usage')} action={action} headerStyle={{ alignItems: 'center' }}>
            {props.signedOut && fetchedAt !== null ? (
                <SectionContentRow>
                    <SurfaceFreshnessLine
                        testID={`${testID}:stale`}
                        reason={t('connectedServicesSettings.detailUsageSignedOutAt', { time: formatAsOfTime(fetchedAt, props.now) })}
                    />
                </SectionContentRow>
            ) : null}
            {facts.refreshing ? (
                <SurfaceStateCard testID={`${testID}:refresh-status`} size="line" kind="loading" title={t('connectedServices.quota.refreshing')} />
            ) : null}
            {facts.creditsOnly && !props.signedOut ? (
                <SurfaceStateCard
                    testID={`${testID}:credits-only`}
                    size="line"
                    kind="warning"
                    title={t('connectedServicesSettings.detailUsageCreditsOnly')}
                />
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
                                    amount={formatConnectedServiceQuotaReportedAmount(meter.reportedAmount)}
                                    resetsAt={meter.resetsAt}
                                    tone={resolveQuotaMeterTone(meter)}
                                    estimated={meter.status === 'estimated'}
                                    size="wide"
                                    // A phone keeps only a short value beside the name; the reset moves beneath.
                                    layout={props.compact ? 'stacked' : undefined}
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
            ) : facts.refreshing ? null : facts.loading ? (
                <SurfaceStateCard testID={`${testID}:loading`} size="line" kind="loading" title={t('common.loading')} />
            ) : failure ? null : props.accessMode?.kind === 'apiKey' ? (
                <Item
                    testID={`${testID}:allowance`}
                    title={t('connectedServicesSettings.detailUsageAllowance')}
                    subtitle={t('connectedServicesSettings.detailUsageNoAllowanceForKeys')}
                    detail={'\u2014'}
                    mode="info"
                    showChevron={false}
                />
            ) : (
                <SurfaceStateCard
                    testID={`${testID}:none`}
                    size="line"
                    kind="empty"
                    title={facts.usageState === 'observed'
                        ? t('connectedServicesCollection.meterNotReported')
                        : t('connectedServicesSettings.usageAppearsAfterSession')}
                />
            )}
            {failure ? (
                <SurfaceStateCard
                    testID={`${testID}:error`}
                    size="line"
                    kind="error"
                    title={failure}
                    action={facts.refresh ? { label: t('common.retry'), onPress: facts.refresh } : undefined}
                />
            ) : null}
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
        : presented.state === 'active'
            ? undefined
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
            : presented.state === 'active' ? `${[props.serviceLabel, props.planLabel].filter(Boolean).join(' ')} · ${t('connectedServicesCollection.subscriptionActive')}`
            : presented.state === 'ends' ? t('connectedServicesCollection.subscriptionEndsIn', { days })
            : t('connectedServicesCollection.subscriptionPeriodEndsIn', { days });
        return <ItemGroup><Item testID={testID} density="compact" title={<View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 }}>
            <StatusDot color={presented.state === 'ends' ? theme.colors.state.warning.foreground : presented.state === 'renews' || presented.state === 'active' ? theme.colors.state.success.foreground : theme.colors.text.tertiary} />
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
                        variant={presented.state === 'ends' ? 'warning' : presented.state === 'renews' || presented.state === 'active' ? 'success' : 'neutral'}
                        label={presented.state === 'ends'
                            ? t('connectedServicesCollection.renewalOff')
                            : presented.state === 'renews' ? t('connectedServicesCollection.renewalOn')
                            : presented.state === 'active' ? t('connectedServicesCollection.subscriptionActive')
                            : t('connectedServicesCollection.renewalUnknown')}
                    />
                )}
            />
        </ItemGroup>
    );
});

/** The account facts' responsive composition, shared by live detail and the specimen fixture. */
export const AccountDetailFactsSectionsView = React.memo(function AccountDetailFactsSectionsView(props: Readonly<{
    facts: AccountDetailUsageFacts;
    accessMode?: ConnectedAccountAccessMode | null;
    serviceLabel: string;
    signedOut: boolean;
    now: number;
    pins?: React.ComponentProps<typeof AccountDetailUsageSectionView>['pins'];
    resetsSection?: React.ReactNode;
}>) {
    const [compact, setCompact] = React.useState(false);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (width !== null) setCompact(width < PAGE_LIST_METRICS.rowStackBelowWidthPx);
    }, []);
    const facts = { ...props.facts, ...projectConnectedAccountSubscriptionFacts(props.accessMode, props.facts) };
    const subscription = <AccountDetailSubscriptionSectionView key="subscription" subscription={facts.subscription} serviceLabel={props.serviceLabel} planLabel={facts.planLabel} now={props.now} compact={compact} />;
    const usage = <AccountDetailUsageSectionView key="usage" facts={facts} accessMode={props.accessMode} signedOut={props.signedOut} now={props.now} pins={props.pins} compact={compact} />;
    const resets = props.resetsSection ?? <AccountDetailResetsSectionView
        recoveryCredits={props.facts.recoveryCredits}
        recoveryCreditDetails={props.facts.recoveryCreditDetails}
        limitMeters={props.facts.limitMeters}
        now={props.now}
        pending={false}
        onUse={null}
    />;
    return <View onLayout={onLayout}>{compact ? [subscription, usage] : [usage, subscription]}{resets}</View>;
});

/**
 * Account detail · Usage resets (lab `csvc` D1): each available reset with when it expires and Use. Each
 * starts a fresh window at once through the one consume operation.
 */
export const AccountDetailResetsSectionView = React.memo(function AccountDetailResetsSectionView(props: Readonly<{
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    recoveryCreditDetails?: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1;
    /** Snapshot meters; names the limits a reset clears in the usage vocabulary. */
    limitMeters?: readonly ConnectedServiceQuotaMeterV1[];
    now: number;
    pending: boolean;
    onUse: ((providerCreditId: string | null) => void) | null;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const rows = buildQuotaResetRows(props.recoveryCredits, props.now, ACCOUNT_BLOCK_RESET_COUNTDOWN_DAYS_FORMATTER, props.recoveryCreditDetails);
    if (rows.length === 0) return null;
    const testID = props.testID ?? 'account-detail-resets';
    return (
        <ItemGroup
            title={t('connectedServicesCollection.usageResetsTitle')}
            description={t('connectedServicesCollection.usageResetsDescription')}
        >
            {rows.map((row) => {
                const expires = row.expiresAtMs === null ? null : new Date(row.expiresAtMs).toLocaleDateString([], { day: 'numeric', month: 'short' });
                const detailLines = [
                    row.description,
                    row.details ? t('connectedServices.account.resets.remainingCount', { count: row.details.remainingCount }) : null,
                    row.details?.appliesToProviderLimitIds.length ? t('connectedServices.account.resets.appliesTo', {
                        limits: resolveResetLimitLabels(row.details.appliesToProviderLimitIds, props.limitMeters ?? EMPTY_LIMIT_METERS, {
                            fiveHour: t('connectedServices.account.resets.fiveHourLimit'),
                            weekly: t('connectedServices.account.resets.weeklyLimit'),
                        }).join(' · '),
                    }) : null,
                    !row.canUse ? row.details?.unavailableReason
                        ? t(`connectedServices.account.resets.unavailableReasons.${row.details.unavailableReason}`)
                        : t('common.unavailable') : null,
                    expires ? [t('connectedServicesCollection.usageResetExpiresOn', { date: expires }), row.countdownLabel].filter(Boolean).join(' · ') : null,
                ].filter(Boolean).join('\n');
                return (
                    <Item
                        key={row.key}
                        testID={`${testID}:${row.key}`}
                        title={row.title ?? t('connectedServicesCollection.usageResetTitle')}
                        subtitle={detailLines || undefined}
                        subtitleLines={0}
                        icon={<Icon name="clock-counter-clockwise" size={17} color={theme.colors.text.secondary} />}
                        mode="info"
                        showChevron={false}
                        rightElement={props.onUse ? (
                            <RoundButton
                                testID={`${testID}:${row.key}:use`}
                                size="small"
                                display="secondary"
                                title={t('connectedServicesCollection.use')}
                                loading={props.pending}
                                disabled={props.pending || !row.canUse}
                                onPress={() => { if (row.canUse && !props.pending) props.onUse?.(row.consumableCreditId); }}
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
    accessMode?: ConnectedAccountAccessMode | null;
    legacyServiceId: ConnectedServiceId | null;
    serviceLabel: string;
    signedOut: boolean;
    machineId?: string | null;
}>) {
    const quota = useQualifiedConnectedAccountQuota(props.account, { refreshMachineId: props.machineId });
    const subscription = useConnectedAccountSubscription(quota.usageRecordId);
    const pins = useConnectedAccountPinnedMeters({ account: props.account, legacyServiceId: props.legacyServiceId });
    const refresh = quota.refresh;
    const retry = React.useCallback(() => { void refresh(); }, [refresh]);
    const snapshot = quota.snapshot;
    const now = Date.now();
    const facts: AccountDetailUsageFacts = {
        meters: snapshot ? projectIndexMeters(snapshot.meters, now, pins.pinnedMeterIds) : [],
        fetchedAt: snapshot?.fetchedAt ?? null,
        planLabel: snapshot?.planLabel ?? null,
        subscription,
        recoveryCredits: snapshot?.recoveryCredits ?? null,
        recoveryCreditDetails: snapshot?.recoveryCreditDetails,
        limitMeters: snapshot?.meters,
        loading: quota.loading,
        error: quota.error,
        refreshing: quota.refreshing,
        refresh: props.machineId === null || quota.supported === false ? null : retry,
        ...(snapshot ? { usageState: snapshot.state === 'not_loaded' ? 'not_loaded' as const : 'observed' as const } : {}),
        creditsOnly: snapshot ? isConnectedAccountQuotaCreditsOnly(snapshot.meters, now) : false,
    };
    return (
        <AccountDetailFactsSectionsView facts={facts} accessMode={props.accessMode} serviceLabel={props.serviceLabel} signedOut={props.signedOut} now={now} pins={pins} resetsSection={props.legacyServiceId && !props.signedOut && props.machineId !== null ? (
                <LiveResetsSection
                    legacyServiceId={props.legacyServiceId}
                    accountId={props.account.accountId}
                    machineId={props.machineId}
                    recoveryCredits={facts.recoveryCredits}
                    recoveryCreditDetails={facts.recoveryCreditDetails}
                    limitMeters={facts.limitMeters}
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
    machineId?: string | null;
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    recoveryCreditDetails?: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1;
    limitMeters?: readonly ConnectedServiceQuotaMeterV1[];
    fetchedAt: number | null;
    onApplied: () => void;
    now: number;
}>) {
    const action = useAccountUsageResetAction({
        legacyServiceId: props.legacyServiceId,
        accountId: props.accountId,
        machineId: props.machineId,
        snapshotFetchedAtMs: props.fetchedAt,
        onApplied: props.onApplied,
    });
    return (
        <AccountDetailResetsSectionView
            recoveryCredits={props.recoveryCredits}
            recoveryCreditDetails={props.recoveryCreditDetails}
            limitMeters={props.limitMeters}
            now={props.now}
            pending={action.pending}
            onUse={(creditId) => { void action.use(creditId); }}
        />
    );
});

/** What the account page adds to its Used by section: the ★ default control and the pools that hold it. */
export type AccountDetailUsedBySlots = Readonly<{
    action?: React.ReactNode;
    children?: React.ReactNode;
}>;

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
} & AccountDetailUsedBySlots>) {
    const { theme } = useUnistyles();
    const hasChildren = React.Children.toArray(props.children).length > 0;
    if (props.rows.length === 0 && !hasChildren && !props.action) return null;
    const testID = props.testID ?? 'account-detail-used-by';
    return (
        <ItemGroup
            testID={testID}
            title={t('connectedServicesSettings.detailUsedByTitle')}
            action={props.action ?? undefined}
            headerStyle={{ alignItems: 'center' }}
            surface={props.rows.length === 0 && !hasChildren ? 'none' : undefined}
        >
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
            {props.children}
        </ItemGroup>
    );
});

/** What the index knows about who uses one account; the projection below orders it for the page. */
export type AccountDetailUsedByInput = Readonly<{
    usedBy: readonly string[];
    usedByAgentIds: readonly string[];
    /** Agents whose default is this account. */
    defaultFor: readonly string[];
    pools: readonly Readonly<{ agent: string; pool: string; inUse: boolean }>[];
    /** Agents contributed by the plugin that contributes this account's service: the account's own Agent. */
    ownAgentIds: readonly string[];
}>;

/**
 * Used by, in reading order (lab `muse-accounts` A1): the account's own Agent first with its real role, then
 * the Agents that default to it, then those through a pool, then the rest in one row.
 */
export function projectAccountDetailUsedByRows(
    input: AccountDetailUsedByInput,
    openAgent: (agentId: string | null) => (() => void) | undefined = () => undefined,
): AccountDetailUsedByRow[] {
    const agentIdByTitle = new Map(input.usedBy.map((title, index) => [title, input.usedByAgentIds[index] ?? null]));
    const direct = new Set(input.defaultFor.filter((agent) => input.usedBy.includes(agent)));
    const throughPools = input.pools.filter((entry) => input.usedBy.includes(entry.agent) && !direct.has(entry.agent));
    const own = input.usedBy.filter((agent) => {
        const agentId = agentIdByTitle.get(agent);
        return agentId != null && input.ownAgentIds.includes(agentId);
    });
    const placed = new Set([...own, ...direct, ...throughPools.map((entry) => entry.agent)]);
    const others = input.usedBy.filter((agent) => !placed.has(agent));
    const row = (agent: string, key: string, subtitle: string, isDefault: boolean): AccountDetailUsedByRow => {
        const agentId = agentIdByTitle.get(agent) ?? null;
        return { key, agentId, title: agent, subtitle, isDefault, onPress: openAgent(agentId) };
    };
    const describe = (agent: string): AccountDetailUsedByRow => {
        if (direct.has(agent)) return row(agent, `direct:${agent}`, t('connectedServicesCollection.usedByDefault'), true);
        const pooled = throughPools.find((entry) => entry.agent === agent);
        if (pooled) {
            return row(agent, `pool:${agent}`, pooled.inUse
                ? t('connectedServicesSettings.detailUsedByPoolInUse', { pool: pooled.pool })
                : t('connectedServicesSettings.detailUsedByPool', { pool: pooled.pool }), false);
        }
        return row(agent, `own:${agent}`, t('connectedServicesSettings.detailUsedByOwnCould'), false);
    };
    return [
        ...own.map(describe),
        ...[...direct].filter((agent) => !own.includes(agent)).map(describe),
        ...throughPools.filter((entry) => !own.includes(entry.agent)).map((entry) => describe(entry.agent)),
        ...(others.length > 0 ? [{
            key: 'others',
            agentId: null,
            title: formatAgentNames(others),
            subtitle: t('connectedServicesSettings.detailUsedByCould'),
            isDefault: false,
        }] : []),
    ];
}

/** The live Used by rows, from the one Connected services index. */
export const AccountDetailUsedBySection = React.memo(function AccountDetailUsedBySection(props: Readonly<{
    account: QualifiedConnectedAccountRef;
    testID?: string;
} & AccountDetailUsedBySlots>) {
    const router = useRouter();
    const serviceKey = buildQualifiedPluginContributionKey(props.account.service);
    const { indexModel, agentEntries } = useConnectedServicesIndex({ agents: 'cached', serviceKey });
    const sheet = indexModel.sheets.find((candidate) => candidate.serviceKey === serviceKey);
    const accountUse = sheet?.usedByByAccountId?.[props.account.accountId];
    if (!sheet || !accountUse || accountUse.usedBy.length === 0) return <AccountDetailUsedBySectionView rows={[]} testID={props.testID} action={props.action}>{props.children}</AccountDetailUsedBySectionView>;
    const roles = sheet.rolesByAccountId[props.account.accountId];
    const pools = (roles?.pools ?? []).flatMap((membership) => {
        const pool = sheet.pools.find((candidate) => candidate.ref.groupId === membership.groupId);
        const name = pool?.displayName ?? pool?.ref.groupId ?? '';
        return (pool?.defaultFor ?? []).map((agent) => ({ agent, pool: name, inUse: membership.inUse }));
    });
    const rows = projectAccountDetailUsedByRows({
        usedBy: accountUse.usedBy,
        usedByAgentIds: accountUse.usedByAgentIds,
        defaultFor: roles?.defaultFor ?? [],
        pools,
        ownAgentIds: agentEntries
            .filter((agent) => agent.identity?.pluginId === props.account.service.pluginId)
            .map((agent) => agent.agentId),
    }, (agentId) => agentId ? () => router.push(`/settings/agents/${agentId}` as never) : undefined);
    return <AccountDetailUsedBySectionView rows={rows} testID={props.testID} action={props.action}>{props.children}</AccountDetailUsedBySectionView>;
});

/** One machine the account works on, with its presence. */
export type AccountDetailMachine = Readonly<{ id: string; name: string; online: boolean; status?: 'online' | 'offline' | 'unknown'; nameLoading?: boolean }>;

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
    const [expanded, setExpanded] = React.useState(false);
    if (props.machines.length === 0) return null;
    // One row that says where it works (lab `s2svc:account`); the full machine list opens under it, so a large
    // fleet never turns the page into a wall of chips.
    // A name still loading says nothing in a summary: name the known ones and count the rest.
    const known = props.machines.filter((machine) => !machine.nameLoading);
    const shown = (known.length > 0 ? known : props.machines).slice(0, WORKS_ON_SUMMARY_NAMES);
    const named = shown.map((machine) => machine.name).join(', ');
    const more = props.machines.length - shown.length;
    const summary = more > 0
        ? t('connectedServicesSettings.detailWorksOnSummaryMore', { names: named, count: more })
        : t('connectedServicesSettings.detailWorksOnSummary', { names: named });
    return (
        // A row of the Sign-in section (lab `s2svc:account`), so its owner supplies the group.
        <ExpandableItem
                testID={`${testID}:disclosure`}
                expanded={expanded}
                onExpandedChange={setExpanded}
                showDivider={false}
                header={(disclosure) => (
                    <Item
                        {...disclosure.headerProps}
                        testID={`${testID}:row`}
                        title={t('connectedServicesSettings.detailWorksOnTitle')}
                        subtitle={summary}
                    />
                )}
            >
            <Text style={styles.worksOnNote}>{t('connectedServicesSettings.detailWorksOnDescription')}</Text>
            <View style={styles.machines} testID={testID}>
                {props.machines.map((machine) => (
                    <View key={machine.id} style={[styles.machine, machine.online ? null : styles.machineOffline]}>
                        <Icon name="desktop" size={13} color={theme.colors.text.secondary} />
                        <Text style={styles.machineName} numberOfLines={1}>{machine.name}</Text>
                        {machine.status !== 'unknown' ? <StatusDot
                            size={6}
                            color={machine.online ? theme.colors.state.success.foreground : theme.colors.text.tertiary}
                            accessibilityLabel={machine.online ? t('status.online') : t('status.offline')}
                        /> : null}
                    </View>
                ))}
            </View>
            </ExpandableItem>
    );
});

/** How many machine names the closed Works on row says before "and N more". */
const WORKS_ON_SUMMARY_NAMES = 3;

/**
 * The machines as Works on names them: the machine list's own names (same-named machines told apart
 * the way the machine picker does), online ones first, each group in its stored order.
 */
export function projectAccountDetailMachines(
    machines: readonly Machine[],
    nowMs: number = Date.now(),
    scope: ServerAccountScope | null = null,
    displayMachines: readonly MachineDisplayRenderable[] = [],
): AccountDetailMachine[] {
    const displayById = new Map(displayMachines.map((machine) => [machine.id, machine]));
    // Held display metadata supplies names only; a locked body must never disclose an older name.
    const namedMachines = machines.map((machine) => machine.availability?.kind === 'locked'
        ? machine
        : displayById.get(machine.id) ?? machine);
    const names = resolveMachineDisplayNames(namedMachines);
    const rows = machines.map((machine, index) => ({
        id: machine.id,
        name: names.get(machine.id) ?? getMachineDisplayName(namedMachines[index]!),
        nameLoading: isMachineDisplayNamePending(namedMachines[index]!),
        online: isMachineSelectableForFleet(scope, machine, nowMs),
        status: describeMachinePresenceLine(machine, nowMs, undefined, scope).status,
    }));
    return [...rows.filter((row) => row.online), ...rows.filter((row) => !row.online)];
}

export const AccountDetailWorksOnSection = React.memo(function AccountDetailWorksOnSection(props: Readonly<{ testID?: string }>) {
    const machines = useActiveMachineFacts();
    const displayMachines = useMachineDisplayById(React.useCallback((displays: Record<string, MachineDisplayRenderable>) => machines.flatMap((machine) => {
        const display = displays[machine.id];
        return display ? [display] : [];
    }), [machines]));
    const scope = useActiveServerAccountScope();
    const reachabilityRevision = useMachineReachabilityRevision();
    const nowMs = useMachinePresenceNowMs(machines);
    const rows = React.useMemo(() => projectAccountDetailMachines(machines, nowMs, scope, displayMachines), [machines, displayMachines, scope, reachabilityRevision, nowMs]);
    return <AccountDetailWorksOnSectionView machines={rows} testID={props.testID} />;
});

const stylesheet = StyleSheet.create((theme) => ({
    compactSubscription: {  ...Typography.variant('body'),  color: theme.colors.text.primary, flexShrink: 1 },
    checked: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    checkedText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    warning: {
        color: theme.colors.state.warning.textForeground,
    },
    worksOnNote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingBottom: theme.space.s8,
    },
    machines: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
        // Opened under its row, on the row's text inset.
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingBottom: theme.space.s12,
    },
    machine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingLeft: theme.space.s8,
        paddingRight: theme.space.s8,
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
        gap: theme.space.s4,
    },
    pinnableMeterRow: {
        flex: 1,
        minWidth: 0,
    },
    machineName: {
        ...Typography.variant('meta'),
        color: theme.colors.text.primary,
    },
}));
