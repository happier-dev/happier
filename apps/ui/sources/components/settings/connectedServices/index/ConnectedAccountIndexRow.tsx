import * as React from 'react';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from '@happier-dev/protocol/connect/connected-service-bindings';
import { useSetting } from '@/sync/domains/state/storage';
import { connectedServiceProfileKey, resolveQualifiedConnectedAccountProfilePreference } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { isConnectedServiceQuotaMeterVisible } from '@/sync/domains/connectedServices/connectedServiceQuotaMeterVisibility';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
    ConnectedServiceId,
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ProviderAccountSubscriptionV1,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useConnectedServiceQuotaSnapshot } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import { selectConnectedServiceQuotaSummaryMeters } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { resolveQuotaMeterTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { t } from '@/text';

import { AccountSubscriptionLine, AccountUsageResetsLine, useConnectedAccountSubscription } from '../usage/AccountUsageFacts';
import { UsageMeterRow, UsageMeterStack, type UsageMeterSize } from '../usage/UsageMeterRow';
import { OpenableSurface } from './OpenableSurface';
import { ConnectedAccountIdentityText } from '../ConnectedAccountIdentityText';

/** One role an account plays: a pool it belongs to (and whether that pool uses it now). */
export type ConnectedAccountIndexRole = Readonly<{
    key: string;
    icon: IconName;
    label: string;
    /** The role is live now ("Work pool · in use"). */
    active: boolean;
}>;

export type ConnectedAccountIndexMeter = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number | null;
    resetsAt: number | null;
    status: ConnectedServiceQuotaMeterV1['status'];
}>;

/** What the account shows beside its identity: its limits, a quiet state, or nothing. */
export type ConnectedAccountIndexUsage =
    | Readonly<{ kind: 'meters'; meters: readonly ConnectedAccountIndexMeter[] }>
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
    signedOut: Readonly<{ reason: string; onSignInAgain: (() => void) | null }> | null;
    /** While a set-up panel is open elsewhere on the page, a row's fix steps down to secondary. */
    fixProminence?: 'primary' | 'secondary';
    legacyServiceId: ConnectedServiceId | null;
    accountId: string;
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

/** Useful and pinned windows, in the provider's order. */
export function projectIndexMeters(
    meters: readonly ConnectedServiceQuotaMeterV1[],
    nowMs: number = Date.now(),
    pinnedMeterIds: readonly string[] = [],
): readonly ConnectedAccountIndexMeter[] {
    return selectConnectedServiceQuotaSummaryMeters({ meters, meterIds: meters.map((meter) => meter.meterId), strategy: 'primary' })
        .flatMap((selected) => selected.meter
            && isConnectedServiceQuotaMeterVisible(selected.meter, nowMs, pinnedMeterIds) ? [{
            meterId: selected.meterId,
            label: selected.label,
            remainingPct: selected.meter.status === 'unavailable' ? null : selected.remainingPct,
            resetsAt: selected.meter.resetAtMs ?? selected.meter.resetsAt ?? null,
            status: selected.meter.status,
        }] : []);
}

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
    if (!facts.subscription && facts.staleSince === null) return null;
    return (
        <View style={styles.statusLines}>
            <AccountSubscriptionLine testID={`${props.testID}:subscription`} subscription={facts.subscription} now={props.now} />
            {facts.staleSince !== null ? (
                <View style={styles.statusLine}>
                    <Icon name="clock" size={12} color={theme.colors.state.warning.foreground} />
                    <Text style={[styles.statusText, styles.warning]} numberOfLines={2}>
                        {t('connectedServicesCollection.usageCheckedMayBeOutOfDate', { time: formatStaleAge(facts.staleSince, props.now) })}
                    </Text>
                </View>
            ) : null}
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

export type ConnectedAccountIndexRowViewProps = ConnectedAccountIndexEntry & Readonly<{
    facts: ConnectedAccountIndexFacts;
    now: number;
    /** Phones stack the limits under the identity (lab C1p). */
    compact: boolean;
    showDivider?: boolean;
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
    return (
        <View pointerEvents="box-none" style={[styles.fix, props.compact ? styles.fixCompact : null]}>
            <View style={styles.statusLine}>
                <Icon name="warning" size={14} color={theme.colors.state.warning.foreground} />
                <Text style={[styles.statusText, styles.warning]}>{props.signedOut.reason}</Text>
            </View>
            <RoundButton
                testID={`${props.testID}:${signIn ? 'sign-in-again' : 'recovery-details'}`}
                size="small"
                display={signIn && props.prominence !== 'secondary' ? 'default' : 'secondary'}
                title={t(signIn ? 'connectedServicesSettings.signInAgain' : 'common.details')}
                onPress={signIn ?? props.onOpen}
            />
        </View>
    );
});

/**
 * An account on the Connected services index, as a list row (lab `csvc` C1): identity on the left (name,
 * email · plan, signed out / subscription / stale, pool chips), every limit on the right with the usage
 * resets under it, then ★ and ↻. A signed-out account carries its fix instead of meters. The row opens
 * the account.
 */
export const ConnectedAccountIndexRowView = React.memo(function ConnectedAccountIndexRowView(props: ConnectedAccountIndexRowViewProps) {
    const { facts } = props;
    const identity = [props.identityLabel, facts.planLabel].filter(Boolean).join(' · ');
    const use = props.signedOut ? (
        <ConnectedAccountSignInRecovery testID={props.testID} signedOut={props.signedOut}
            onOpen={props.onOpen} compact={props.compact} prominence={props.fixProminence} />
    ) : (
        <>
            <View pointerEvents={facts.usage.kind === 'error' ? 'box-none' : 'none'}>
                <ConnectedAccountIndexUsageBlock testID={props.testID} usage={facts.usage} now={props.now} align="end" />
            </View>
            <AccountUsageResetsLine
                testID={`${props.testID}:resets`}
                recoveryCredits={facts.recoveryCredits}
                legacyServiceId={props.legacyServiceId}
                accountId={props.accountId}
                snapshotFetchedAtMs={facts.fetchedAt}
                now={props.now}
                onApplied={() => facts.refresh?.()}
            />
        </>
    );
    const actions = (
        <ConnectedAccountIndexActions
            testID={props.testID}
            star={props.star}
            refresh={props.signedOut || facts.usage.kind === 'noLimits' ? null : facts.refresh}
            refreshing={facts.refreshing}
        />
    );
    return (
        <OpenableSurface
            testID={props.testID}
            accessibilityLabel={props.title}
            onPress={props.onOpen}
            style={[
                styles.row,
                props.compact ? styles.rowCompact : null,
                props.showDivider !== false ? styles.divider : null,
            ]}
            hoveredStyle={styles.hovered}
        >
            <View pointerEvents="box-none" style={props.compact ? styles.compactHead : styles.identity}>
                <View pointerEvents="none" style={styles.identityText}>
                    <ConnectedAccountIdentityText value={props.title} style={styles.title} numberOfLines={1} />
                    {identity ? <ConnectedAccountIdentityText value={identity} style={styles.subtitle} numberOfLines={1} /> : null}
                    <ConnectedAccountIndexStatusLines
                        testID={props.testID}
                        facts={facts}
                        now={props.now}
                    />
                    <ConnectedAccountIndexRoles testID={props.testID} roles={props.roles} />
                </View>
                {props.compact ? actions : null}
            </View>
            <View pointerEvents="box-none" style={props.compact ? styles.useCompact : styles.use}>{use}</View>
            {props.compact ? null : actions}
        </OpenableSurface>
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
        ? { kind: 'meters', meters }
        : quota.loading ? { kind: 'loading' }
            : quota.error ? { kind: 'error', retry }
                : billedPerUse && snapshot?.meters.length === 0 ? { kind: 'noLimits' } : { kind: 'none' };
    return {
        usage,
        planLabel: snapshot?.planLabel ?? null,
        subscription,
        recoveryCredits: snapshot?.recoveryCredits ?? null,
        fetchedAt: snapshot?.fetchedAt ?? null,
        staleSince: snapshot && now - snapshot.fetchedAt > snapshot.staleAfterMs ? snapshot.fetchedAt : null,
        refreshing: quota.refreshing,
        refresh: quota.supported === false ? null : retry,
    };
}

/** Reads a released V2 account's usage (no subscription record on that transport). */
function useLegacyFacts(serviceId: ConnectedServiceId, profileId: string, status: unknown, billedPerUse: boolean): ConnectedAccountIndexFacts {
    const quota = useConnectedServiceQuotaSnapshot({ serviceId, profileId, credentialHealthStatus: status });
    const pinnedByKey = useSetting('connectedServicesQuotaPinnedMeterIdsByKey');
    const pinnedMeterIds = pinnedByKey[connectedServiceProfileKey({ serviceId, profileId })] ?? [];
    const snapshot = quota.snapshot;
    const refresh = quota.refresh;
    const retry = React.useCallback(() => { void refresh(); }, [refresh]);
    const meters = snapshot ? projectIndexMeters(snapshot.meters, quota.nowMs, pinnedMeterIds) : [];
    const usage: ConnectedAccountIndexUsage = meters.length > 0
        ? { kind: 'meters', meters }
        : quota.loading ? { kind: 'loading' }
            : quota.error ? { kind: 'error', retry }
                : billedPerUse && snapshot?.meters.length === 0 ? { kind: 'noLimits' } : { kind: 'none' };
    return {
        usage,
        planLabel: snapshot?.planLabel ?? null,
        subscription: null,
        recoveryCredits: snapshot?.recoveryCredits ?? null,
        fetchedAt: snapshot?.fetchedAt ?? null,
        staleSince: snapshot && quota.nowMs - snapshot.fetchedAt > snapshot.staleAfterMs ? snapshot.fetchedAt : null,
        refreshing: false,
        refresh: retry,
    };
}

export type ConnectedAccountIndexIdentity =
    | Readonly<{ kind: 'qualified'; account: QualifiedConnectedAccountRef }>
    | Readonly<{ kind: 'legacy'; serviceId: ConnectedServiceId; profileId: string }>;

type LiveProps = Readonly<{
    identity: ConnectedAccountIndexIdentity;
    status: unknown;
    /** Keys and tokens that report no limits say so; other kinds stay quiet. */
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
    const facts = useLegacyFacts(props.serviceId, props.profileId, props.status, props.billedPerUse);
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
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 18,
        paddingTop: 13,
        paddingBottom: 13,
        paddingRight: 10,
        // Accounts align under their service's name (mark box + gap + sheet inset).
        paddingLeft: 58,
    },
    rowCompact: {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 12,
        paddingLeft: 14,
        paddingRight: 8,
    },
    divider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    hovered: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    identity: {
        flex: 1,
        minWidth: 0,
    },
    compactHead: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    identityText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 13.5,
        lineHeight: 19,
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        marginTop: 1,
        color: theme.colors.text.secondary,
    },
    statusLines: {
        marginTop: 2,
        gap: 2,
    },
    statusLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    statusText: {
        ...Typography.default(),
        flexShrink: 1,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    warning: {
        color: theme.colors.state.warning.foreground,
    },
    roles: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 5,
        marginTop: 8,
    },
    role: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: 20,
        paddingHorizontal: 7,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.inset,
    },
    roleLabel: {
        ...Typography.default('medium'),
        fontSize: 11.5,
        lineHeight: 15,
        color: theme.colors.text.secondary,
    },
    roleLabelActive: {
        color: theme.colors.text.primary,
    },
    use: {
        width: 364,
        flexShrink: 1,
        minWidth: 0,
        paddingTop: 2,
        gap: 9,
    },
    useCompact: {
        gap: 9,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -3,
    },
    fix: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 30,
    },
    fixCompact: {
        flexDirection: 'column',
        alignItems: 'flex-start',
    },
    usageLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    quiet: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.tertiary,
    },
    alignEnd: {
        textAlign: 'right',
    },
}));
