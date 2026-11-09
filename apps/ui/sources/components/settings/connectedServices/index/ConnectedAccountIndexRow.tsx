import * as React from 'react';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from '@happier-dev/protocol/connect/connected-service-bindings';
import { useSetting } from '@/sync/domains/state/storage';
import { connectedServiceProfileKey, resolveQualifiedConnectedAccountProfilePreference } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
    ConnectedServiceId} from '@happier-dev/protocol/connect/connected-service-bindings';
import type {
    ConnectedServiceQuotaRecoveryCreditsV1} from '@happier-dev/protocol/connect/connected-service-schemas';
import type {
    ProviderAccountSubscriptionV1} from '@happier-dev/protocol/connect/accountSubscription';
import type {
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { PopoverAnchor } from '@/components/ui/popover/_types';
import { Item } from '@/components/ui/lists/Item';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import { resolveQuotaMeterTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { t } from '@/text';

import { AccountSubscriptionLine, useConnectedAccountSubscription } from '../usage/AccountUsageFacts';
import { UsageMeterRow, UsageMeterStack, type UsageMeterSize } from '../usage/UsageMeterRow';
import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { presentConnectedAccountAccessMode, type ConnectedAccountAccessMode } from '../model/presentConnectedAccountAccessMode';
import { projectConnectedAccountSubscriptionFacts, resolveConnectedAccountAccessMode } from '../model/resolveConnectedAccountAccessMode';
import { projectIndexMeters, type ConnectedAccountIndexMeter } from './projectIndexMeters';
import { formatConnectedServiceQuotaReportedAmount } from '@/sync/domains/connectedServices/accountUsage/formatProviderUsageAmount';
export { projectIndexMeters, type ConnectedAccountIndexMeter } from './projectIndexMeters';

/** One role an account plays: a pool it belongs to (and whether that pool uses it now). */
export type ConnectedAccountIndexRole = Readonly<{
    key: string;
    icon: IconName;
    label: string;
    /** The role is live now ("Work pool · in use"). */
    active: boolean;
}>;

/** What the account shows beside its identity: its limits, a quiet state, or nothing. */
export type ConnectedAccountIndexUsage =
    | Readonly<{ kind: 'meters'; meters: readonly ConnectedAccountIndexMeter[]; error?: string | null }>
    /** Only the meters wait; the row is already there. Two placeholder windows hold the space. */
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'error'; retry: () => void }>
    /** Keys: the provider reports no limits and bills per use. */
    | Readonly<{ kind: 'noLimits' }>
    | Readonly<{ kind: 'none' }>;

/** Everything an account row or card shows from the account's usage record. */
export type ConnectedAccountIndexFacts = Readonly<{
    usage: ConnectedAccountIndexUsage;
    planLabel: string | null;
    subscription: ProviderAccountSubscriptionV1 | null;
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    fetchedAt: number | null;
    /** Last read older than the snapshot's own freshness window ("Checked 3 days ago"). */
    staleSince: number | null;
    refreshing: boolean;
    refresh: (() => void) | null;
}>;

/** Who the account is and what it needs, from the index model (no usage). */
export type ConnectedAccountIndexEntry = Readonly<{
    testID: string;
    title: string;
    identityLabel: string | null;
    roles: readonly ConnectedAccountIndexRole[];
    /** The account needs a new sign-in: the fix sits on the row, the cause under its name. */
    signedOut: Readonly<{ reason: string; onSignInAgain: ((anchor?: PopoverAnchor) => void) | null }> | null;
    /** While a set-up panel is open elsewhere on the page, a row's fix steps down to secondary. */
    fixProminence?: 'primary' | 'secondary';
    legacyServiceId: ConnectedServiceId | null;
    /** The service's owning plugin: its packaged brand is the row's mark when no built-in mark exists (as in the rail). */
    pluginId?: string | null;
    accountId: string;
    /** Subscription or API key, from the account's record: said once, on line 2 (lab `muse-accounts` A1). */
    accessMode?: ConnectedAccountAccessMode | null;
    /** ★: default for an agent (the per-agent default menu). */
    star: React.ReactNode;
    onOpen: () => void;
}>;

const LOADING_METER_KEYS = ['first', 'second'] as const;
const EMPTY_FACTS: ConnectedAccountIndexFacts = {
    usage: { kind: 'none' },
    planLabel: null,
    subscription: null,
    recoveryCredits: null,
    fetchedAt: null,
    staleSince: null,
    refreshing: false,
    refresh: null,
};

/** The account's limits as the one meter draws them, or its quiet state. */
export const ConnectedAccountIndexUsageBlock = React.memo(function ConnectedAccountIndexUsageBlock(props: Readonly<{
    testID: string;
    usage: ConnectedAccountIndexUsage;
    now: number;
    size?: UsageMeterSize;
    align?: 'start' | 'end';
}>) {
    const { usage } = props;
    if (usage.kind === 'meters' && usage.meters.length > 0) {
        return (
            <UsageMeterStack testID={`${props.testID}:meters`}>
                {usage.meters.map((meter) => (
                    <UsageMeterRow
                        key={meter.meterId}
                        label={meter.label}
                        remainingPct={meter.remainingPct}
                        amount={formatConnectedServiceQuotaReportedAmount(meter.reportedAmount)}
                        resetsAt={meter.resetsAt}
                        tone={resolveQuotaMeterTone(meter)}
                        estimated={meter.status === 'estimated'}
                        size={props.size}
                        now={props.now}
                    />
                ))}
            </UsageMeterStack>
        );
    }
    if (usage.kind === 'loading') {
        return (
            <UsageMeterStack testID={`${props.testID}:meters-loading`}>
                {LOADING_METER_KEYS.map((key) => (
                    <UsageMeterRow key={key} label="" remainingPct={null} resetsAt={null} tone="neutral" size={props.size} now={props.now} loading />
                ))}
            </UsageMeterStack>
        );
    }
    if (usage.kind === 'error') {
        return (
            <View style={styles.usageLine}>
                <Text style={styles.quiet} numberOfLines={1}>{t('connectedServicesSettings.usageReadFailed')}</Text>
                <RoundButton
                    testID={`${props.testID}:usage-retry`}
                    size="small"
                    display="secondary"
                    title={t('common.retry')}
                    onPress={usage.retry}
                />
            </View>
        );
    }
    if (usage.kind === 'noLimits') {
        return (
            <Text testID={`${props.testID}:no-limits`} style={[styles.quiet, props.align === 'end' ? styles.alignEnd : null]} numberOfLines={1}>
                {t('connectedServicesSettings.noLimitsBilledPerUse')}
            </Text>
        );
    }
    return null;
});

/** The identity column's subscription and stale read; sign-out is owned by its recovery. */
export const ConnectedAccountIndexStatusLines = React.memo(function ConnectedAccountIndexStatusLines(props: Readonly<{
    testID: string;
    facts: ConnectedAccountIndexFacts;
    now: number;
}>) {
    const { theme } = useUnistyles();
    const { facts } = props;
    // A fresh card's time is the page header's "As of", said once; a card names its own time only while it refreshes,
    // after a failed refresh, or once it is stale.
    const failedRefresh = facts.usage.kind === 'meters' && Boolean(facts.usage.error);
    const ownTime = facts.fetchedAt !== null && facts.staleSince === null && (facts.refreshing || failedRefresh);
    if (!facts.subscription && facts.staleSince === null && !ownTime && !facts.refreshing && !failedRefresh) return null;
    return (
        // Facts, never a target: a press goes through to the card, except the failed refresh's own Retry.
        <View pointerEvents="box-none" style={styles.statusLines}>
            {facts.refreshing ? (
                <SurfaceStateCard testID={`${props.testID}:refresh-status`} size="line" kind="loading" title={t('connectedServices.quota.refreshing')} />
            ) : null}
            {facts.usage.kind === 'meters' && facts.usage.error ? (
                <SurfaceFreshnessLine testID={`${props.testID}:refresh-error`} reason={t('connectedServicesSettings.usageReadFailed')} tone="warning"
                    {...(facts.refresh ? { action: { label: t('common.retry'), onPress: facts.refresh } } : {})} />
            ) : null}
            {ownTime ? <SurfaceAsOfLabel at={facts.fetchedAt!} testID={`${props.testID}:as-of`} /> : null}
            <AccountSubscriptionLine testID={`${props.testID}:subscription`} subscription={facts.subscription} now={props.now} />
            {facts.staleSince !== null ? <ConnectedAccountUsageFreshnessLine testID={props.testID} facts={{ ...facts, usage: { kind: 'none' } }} now={props.now} /> : null}
        </View>
    );
});

function formatStaleAge(since: number, now: number): string {
    const days = Math.floor((now - since) / (24 * 60 * 60 * 1000));
    if (days >= 1) return t('connectedServicesCollection.daysAgo', { count: days });
    const hours = Math.max(1, Math.floor((now - since) / (60 * 60 * 1000)));
    return t('connectedServicesCollection.hoursAgo', { count: hours });
}

/** Pool chips: "Work pool · in use", "Codex pool". */
export const ConnectedAccountIndexRoles = React.memo(function ConnectedAccountIndexRoles(props: Readonly<{
    testID: string;
    roles: readonly ConnectedAccountIndexRole[];
}>) {
    const { theme } = useUnistyles();
    if (props.roles.length === 0) return null;
    return (
        <View style={styles.roles}>
            {props.roles.map((role) => (
                <View key={role.key} testID={`${props.testID}:role:${role.key}`} style={styles.role}>
                    <Icon name={role.icon} size={11} color={role.active ? theme.colors.text.primary : theme.colors.text.secondary} />
                    <Text style={[styles.roleLabel, role.active ? styles.roleLabelActive : null]} numberOfLines={1}>{role.label}</Text>
                </View>
            ))}
        </View>
    );
});

/** The row's quiet actions: ★ (default for an agent) and ↻ (read the usage again). */
export const ConnectedAccountIndexActions = React.memo(function ConnectedAccountIndexActions(props: Readonly<{
    testID: string;
    star: React.ReactNode;
    refresh: (() => void) | null;
    refreshing: boolean;
    more?: React.ReactNode;
}>) {
    return (
        <View pointerEvents="box-none" style={styles.actions}>
            {props.star}
            {props.refresh ? (
                <IconButton
                    testID={`${props.testID}:refresh`}
                    iconName="arrows-clockwise"
                    size={28}
                    iconSize={15}
                    variant="plain"
                    accessibilityLabel={t('connectedServicesCollection.refreshUsage')}
                    tooltip={t('connectedServicesCollection.refreshUsage')}
                    disabled={props.refreshing}
                    onPress={props.refresh}
                />
            ) : null}
            {props.more ?? null}
        </View>
    );
});

/** The usage an account can read again: none while it needs a sign-in or reports no limits (rows and cards alike). */
export function resolveConnectedAccountUsageRefresh(
    facts: ConnectedAccountIndexFacts,
    signedOut: ConnectedAccountIndexEntry['signedOut'],
): (() => void) | null {
    return signedOut || facts.usage.kind === 'noLimits' ? null : facts.refresh;
}

export type ConnectedAccountIndexRowViewProps = ConnectedAccountIndexEntry & Readonly<{
    facts: ConnectedAccountIndexFacts;
    now: number;
    /** Phones stack the limits under the identity (lab C1p). */
    compact: boolean;
    showDivider?: boolean;
    /** The fact line's word when no plan is known: the service, on a sheet that mixes services. */
    serviceFact?: string | null;
}>;

/** One explanation and one available next step, shared by account rows and cards. */
export const ConnectedAccountSignInRecovery = React.memo(function ConnectedAccountSignInRecovery(props: Readonly<{
    testID: string;
    signedOut: NonNullable<ConnectedAccountIndexEntry['signedOut']>;
    onOpen: () => void;
    compact?: boolean;
    prominence?: 'primary' | 'secondary';
}>) {
    const { theme } = useUnistyles();
    const signIn = props.signedOut.onSignInAgain;
    // The Connect sheet hangs from this button (popover on wide layouts).
    const triggerRef = React.useRef<View>(null);
    return (
        <View pointerEvents="box-none" style={[styles.fix, props.compact ? styles.fixCompact : null]}>
            <View style={styles.statusLine}>
                <Icon name="warning" size={14} color={theme.colors.state.warning.foreground} />
                <Text style={[styles.statusText, styles.warning]}>{props.signedOut.reason}</Text>
            </View>
            <View ref={triggerRef} collapsable={false}>
                <RoundButton
                    testID={`${props.testID}:${signIn ? 'sign-in-again' : 'recovery-details'}`}
                    size="small"
                    display={signIn && props.prominence !== 'secondary' ? 'default' : 'secondary'}
                    title={t(signIn ? 'connectedServicesSettings.signInAgain' : 'common.details')}
                    onPress={signIn ? () => signIn({ kind: 'view', ref: triggerRef }) : props.onOpen}
                />
            </View>
        </View>
    );
});

/**
 * An account on the Credentials list (lab `cr` crHome A): one sheet row like every other on the page. The
 * service's mark, the account (a subscription's email) and one fact line (its name and plan, or its
 * service), then one trailing thing: its limits, or the fix when it needs a new sign-in. Old usage says so
 * under the fact line. The whole row opens the account, where its default, refresh, resets and pools live;
 * the page header's "Refresh all" reads every row again (R138: no per-row actions).
 */
export const ConnectedAccountIndexRowView = React.memo(function ConnectedAccountIndexRowView(props: ConnectedAccountIndexRowViewProps) {
    const { facts } = props;
    const accessMode = props.accessMode ?? resolveConnectedAccountAccessMode(null, facts.subscription);
    const fact = [
        props.identityLabel,
        accessMode ? presentConnectedAccountAccessMode(accessMode, facts.planLabel) : facts.planLabel ?? props.serviceFact ?? null,
    ].filter(Boolean).join(' · ');
    // A page row lends its trailing control the row's padding; a stack of meters is taller than one control, so it
    // keeps that padding and the row grows around it instead of the stack crossing its dividers (R137 Credentials).
    const rowPadding = usePageRowMetrics().paddingVerticalPx;
    const keepRowPadding = props.compact ? null : { marginVertical: rowPadding };
    const usage = (
        <View pointerEvents={facts.usage.kind === 'error' ? 'box-none' : 'none'}
            style={props.compact ? null : [styles.use, keepRowPadding]}>
            <ConnectedAccountIndexUsageBlock testID={props.testID} usage={facts.usage} now={props.now} align="end" />
        </View>
    );
    const trailing = props.signedOut ? (
        <ConnectedAccountSignInRecovery testID={props.testID} signedOut={props.signedOut}
            onOpen={props.onOpen} compact={props.compact} prominence={props.fixProminence} />
    ) : usage;
    const staleOrFailed = facts.staleSince !== null || (facts.usage.kind === 'meters' && Boolean(facts.usage.error));
    return (
        <Item
            testID={props.testID}
            title={props.title}
            subtitle={fact || undefined}
            icon={<ConnectedServiceMark legacyServiceId={props.legacyServiceId} pluginId={props.pluginId} size="inline" />}
            rightElement={trailing}
            rightElementOutsidePressable={Boolean(props.signedOut) || facts.usage.kind === 'error'}
            keepChevronWithRightElement={!props.signedOut}
            showChevron={!props.signedOut}
            accessoryLayout="adaptive"
            bottomElement={staleOrFailed ? <ConnectedAccountUsageFreshnessLine testID={props.testID} facts={facts} now={props.now} /> : undefined}
            bottomElementInset="text"
            showDivider={props.showDivider}
            onPress={props.onOpen}
        />
    );
});

/** Usage a row shows that may be wrong: an old read, or a refresh that failed beside last-known limits. */
export const ConnectedAccountUsageFreshnessLine = React.memo(function ConnectedAccountUsageFreshnessLine(props: Readonly<{
    testID: string;
    facts: ConnectedAccountIndexFacts;
    now: number;
}>) {
    const { theme } = useUnistyles();
    const { facts } = props;
    if (facts.usage.kind === 'meters' && facts.usage.error) {
        return <SurfaceFreshnessLine testID={`${props.testID}:refresh-error`} reason={t('connectedServicesSettings.usageReadFailed')} tone="warning"
                    {...(facts.refresh ? { action: { label: t('common.retry'), onPress: facts.refresh } } : {})} />;
    }
    if (facts.staleSince === null) return null;
    return (
        <View testID={`${props.testID}:stale`} style={styles.statusLine}>
            {/* Old usage is a fact, not a call to act: neutral ink, like the pool page (amber means "needs you"). */}
            <Icon name="clock" size={12} color={theme.colors.text.secondary} />
            <Text style={styles.statusText} numberOfLines={2}>
                {t('connectedServicesCollection.usageCheckedMayBeOutOfDate', { time: formatStaleAge(facts.staleSince, props.now) })}
            </Text>
        </View>
    );
});

/** Reads a V4 account's usage record: quota (meters, plan, resets) and its subscription. */
function useQualifiedFacts(account: QualifiedConnectedAccountRef, billedPerUse: boolean): ConnectedAccountIndexFacts {
    const quota = useQualifiedConnectedAccountQuota(account);
    const pinnedByKey = useSetting('connectedServicesQuotaPinnedMeterIdsByKey');
    const pinnedMeterIds = resolveQualifiedConnectedAccountProfilePreference({
        valuesByKey: pinnedByKey, service: account.service, accountId: account.accountId,
        legacyServiceId: readBuiltInLegacyConnectedServiceIdForQualifiedService(account.service),
    }) ?? [];
    const subscription = useConnectedAccountSubscription(quota.usageRecordId);
    const snapshot = quota.snapshot;
    const refresh = quota.refresh;
    const retry = React.useCallback(() => { void refresh(); }, [refresh]);
    const now = Date.now();
    const meters = snapshot ? projectIndexMeters(snapshot.meters, now, pinnedMeterIds) : [];
    const usage: ConnectedAccountIndexUsage = meters.length > 0
        ? { kind: 'meters', meters, error: quota.error }
        : quota.loading ? { kind: 'loading' }
            : quota.error ? { kind: 'error', retry }
                : billedPerUse && snapshot?.meters.length === 0 ? { kind: 'noLimits' } : { kind: 'none' };
    const subscriptionFacts = projectConnectedAccountSubscriptionFacts(
        billedPerUse ? { kind: 'apiKey', keySuffix: null } : null,
        { planLabel: snapshot?.planLabel ?? null, subscription },
    );
    return {
        usage,
        ...subscriptionFacts,
        recoveryCredits: snapshot?.recoveryCredits ?? null,
        fetchedAt: snapshot?.fetchedAt ?? null,
        staleSince: snapshot && now - snapshot.fetchedAt > snapshot.staleAfterMs ? snapshot.fetchedAt : null,
        refreshing: quota.refreshing,
        refresh: quota.supported === false ? null : retry,
    };
}

/** Reads a released V2 account's usage (no subscription record on that transport). */
function useLegacyFacts(serviceId: ConnectedServiceId, profileId: string, billedPerUse: boolean): ConnectedAccountIndexFacts {
    // A displayed quota is a read, not a recovery-credit operation. The shared
    // reader owns negotiation/currentness; "Use one" mounts its own Action only
    // when the account actually reports a usable reset.
    const profiles = React.useMemo(() => [{ serviceId, profileId }], [serviceId, profileId]);
    const quota = useConnectedServiceQuotaSnapshots(profiles);
    const key = quota.profiles[0]?.key;
    const pinnedByKey = useSetting('connectedServicesQuotaPinnedMeterIdsByKey');
    const pinnedMeterIds = pinnedByKey[connectedServiceProfileKey({ serviceId, profileId })] ?? [];
    const snapshot = key ? quota.snapshotsByKey[key] ?? null : null;
    const error = key ? quota.errorsByKey[key] ?? null : null;
    const refresh = quota.refresh;
    const retry = React.useCallback(() => { if (key) void refresh([key]); }, [key, refresh]);
    const now = Date.now();
    const meters = snapshot ? projectIndexMeters(snapshot.meters, now, pinnedMeterIds) : [];
    const usage: ConnectedAccountIndexUsage = meters.length > 0
        ? { kind: 'meters', meters, error }
        : key && quota.loadingByKey[key] ? { kind: 'loading' }
            : error ? { kind: 'error', retry }
                : billedPerUse && snapshot?.meters.length === 0 ? { kind: 'noLimits' } : { kind: 'none' };
    return {
        usage,
        planLabel: snapshot?.planLabel ?? null,
        subscription: null,
        recoveryCredits: snapshot?.recoveryCredits ?? null,
        fetchedAt: snapshot?.fetchedAt ?? null,
        staleSince: snapshot && now - snapshot.fetchedAt > snapshot.staleAfterMs ? snapshot.fetchedAt : null,
        refreshing: key ? quota.refreshingByKey[key] ?? false : false,
        refresh: key && quota.refreshableKeys.includes(key) ? retry : null,
    };
}

export type ConnectedAccountIndexIdentity =
    | Readonly<{ kind: 'qualified'; account: QualifiedConnectedAccountRef }>
    | Readonly<{ kind: 'legacy'; serviceId: ConnectedServiceId; profileId: string }>;

type LiveProps = Readonly<{
    identity: ConnectedAccountIndexIdentity;
    status: unknown;
    /** Explicit API-key accounts with no reported limits say so. */
    billedPerUse: boolean;
    /** Tools and code hosts never report usage. */
    showsUsage: boolean;
    signedOut: boolean;
    /** "Refresh all": each bump reads this account again. */
    refreshToken?: number;
    render: (facts: ConnectedAccountIndexFacts) => React.ReactElement;
}>;

/** Reads the account again when "Refresh all" bumps the token (never on mount). */
function useRefreshOnToken(token: number | undefined, refresh: (() => void) | null): void {
    const seen = React.useRef(token);
    React.useEffect(() => {
        if (token === undefined || token === seen.current) return;
        seen.current = token;
        refresh?.();
    }, [refresh, token]);
}

const QualifiedFacts = React.memo(function QualifiedFacts(props: LiveProps & { account: QualifiedConnectedAccountRef }) {
    const facts = useQualifiedFacts(props.account, props.billedPerUse);
    useRefreshOnToken(props.refreshToken, facts.refresh);
    return props.render(facts);
});

const LegacyFacts = React.memo(function LegacyFacts(props: LiveProps & { serviceId: ConnectedServiceId; profileId: string }) {
    const facts = useLegacyFacts(props.serviceId, props.profileId, props.billedPerUse);
    useRefreshOnToken(props.refreshToken, facts.refresh);
    return props.render(facts);
});

/**
 * An account's live usage facts, read by the leaf that shows them (one shared snapshot store per
 * account), so the index never waits on usage and a signed-out account asks for nothing.
 */
export const ConnectedAccountIndexLiveFacts = React.memo(function ConnectedAccountIndexLiveFacts(props: LiveProps) {
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    if (!props.showsUsage || !quotasEnabled || props.signedOut || shouldHideQuotaForCredentialStatus(props.status)) {
        return props.render(props.showsUsage && props.billedPerUse && !props.signedOut
            ? { ...EMPTY_FACTS, usage: { kind: 'noLimits' } }
            : EMPTY_FACTS);
    }
    return props.identity.kind === 'qualified'
        ? <QualifiedFacts {...props} account={props.identity.account} />
        : <LegacyFacts {...props} serviceId={props.identity.serviceId} profileId={props.identity.profileId} />;
});


const styles = StyleSheet.create((theme) => ({
    statusLines: {
        gap: theme.space.s2,
    },
    statusLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    statusText: {
        flexShrink: 1,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    warning: {
        // The glyph keeps the warning hue; its words take the deeper warning text role.
        color: theme.colors.state.warning.textForeground,
    },
    roles: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s4,
    },
    role: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        height: 20,
        paddingHorizontal: theme.space.s6,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.inset,
    },
    roleLabel: {
        ...Typography.variant('micro', 'medium'),
        color: theme.colors.text.secondary,
    },
    roleLabelActive: {
        color: theme.colors.text.primary,
    },
    use: {
        width: 364,
        flexShrink: 1,
        minWidth: 0,
        paddingTop: theme.space.s2,
        gap: theme.space.s8,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -3,
    },
    fix: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 30,
    },
    fixCompact: {
        flexDirection: 'column',
        alignItems: 'flex-start',
    },
    usageLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    quiet: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    alignEnd: {
        textAlign: 'right',
    },
}));
