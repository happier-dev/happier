import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import { summarizeConnectedServiceQuotaRecoveryCredits } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { presentAccountSubscription } from '@/sync/domains/connectedServices/presentAccountSubscription';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatResetAtTime } from '@/utils/time/formatResetAtTime';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import type {
    ConnectedServiceId,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ProviderAccountSubscriptionV1,
    ProviderAccountUsageRecordId,
} from '@happier-dev/protocol';

import { useAccountUsageResetAction } from './useAccountUsageResetAction';

const EMPTY_RECORD_IDS: readonly string[] = [];

/**
 * An account's subscription, read from the provider usage record its quota came from (the server-minted
 * record id binds the two reads). Null while unknown: nothing is inferred from a missing record.
 */
export function useConnectedAccountSubscription(recordId: ProviderAccountUsageRecordId | null): ProviderAccountSubscriptionV1 | null {
    const ids = React.useMemo(() => (recordId ? [recordId] : EMPTY_RECORD_IDS), [recordId]);
    const usage = useProviderAccountUsageSnapshots(ids);
    return recordId ? usage.snapshotsByRecordId[recordId]?.subscription ?? null : null;
}

/**
 * The subscription line under an account's name (lab `csvc` C1, C2, U1): "● Renews in 17 days", or
 * "● Not renewing · ends in 5 days" in the warning tone, then "Checked 3 days ago · may be out of date"
 * once the producer's freshness window has passed. Renders nothing when the producer said nothing.
 */
export const AccountSubscriptionLine = React.memo(function AccountSubscriptionLine(props: Readonly<{
    subscription: ProviderAccountSubscriptionV1 | null;
    now: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const presented = presentAccountSubscription(props.subscription, props.now);
    if (!presented) return null;
    const warning = presented.state === 'ends';
    const text = presented.state === 'none'
        ? t('connectedServicesCollection.subscriptionNone')
        : presented.state === 'renews'
            ? t('connectedServicesCollection.subscriptionRenewsIn', { days: presented.days ?? 0 })
            : presented.state === 'ends'
                ? t('connectedServicesCollection.subscriptionEndsIn', { days: presented.days ?? 0 })
                : t('connectedServicesCollection.subscriptionPeriodEndsIn', { days: presented.days ?? 0 });
    return (
        <View testID={props.testID} style={styles.lines}>
            <View style={styles.line}>
                <View style={[styles.dot, {
                    backgroundColor: warning
                        ? theme.colors.state.warning.foreground
                        : presented.state === 'renews' ? theme.colors.status.connected : theme.colors.text.tertiary,
                }]} />
                <Text style={[styles.text, warning ? styles.warning : null]} numberOfLines={1}>{text}</Text>
            </View>
            {presented.stale ? (
                <View style={styles.line}>
                    <Icon name="clock" size={12} color={theme.colors.state.warning.foreground} />
                    <Text style={[styles.text, styles.warning]} numberOfLines={2}>
                        {t('connectedServicesCollection.checkedMayBeOutOfDate', { time: formatAsOfTime(presented.checkedAtMs, props.now) })}
                    </Text>
                </View>
            ) : null}
        </View>
    );
});

/**
 * An account's usage resets in one line (lab `csvc` C1, C2, U1): "↺ 3 usage resets · first expires Oct 5"
 * and "Use one", which applies the next reset through the one consume operation. Renders nothing when
 * the account has no reset available.
 */
export type AccountUsageResetsAction = Readonly<{ onUse: () => void; pending: boolean }>;

export const AccountUsageResetsLine = React.memo(function AccountUsageResetsLine(props: Readonly<{
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined;
    /** Cached identity stays open-ended; only built-in service IDs enable connected-account consume. */
    legacyServiceId: string | null;
    accountId: string | null;
    snapshotFetchedAtMs: number | null;
    now: number;
    /** After a reset is applied: read the account again so its meters show the fresh window. */
    onApplied: () => void;
    /**
     * A caller-owned "Use one" (a session that signs in on its own consumes its resets through the
     * session's path); when present it replaces the connected-account consume.
     */
    action?: AccountUsageResetsAction;
    testID?: string;
}>) {
    const summary = summarizeConnectedServiceQuotaRecoveryCredits(props.recoveryCredits, props.now);
    if (!summary) return null;
    const legacyServiceId = ConnectedServiceIdSchema.safeParse(props.legacyServiceId);
    return (
        <ResetsLineView
            {...props}
            summary={summary}
            legacyServiceId={legacyServiceId.success ? legacyServiceId.data : null}
        />
    );
});

const ResetsLineView = React.memo(function ResetsLineView(props: Readonly<{
    summary: NonNullable<ReturnType<typeof summarizeConnectedServiceQuotaRecoveryCredits>>;
    legacyServiceId: ConnectedServiceId | null;
    accountId: string | null;
    action?: AccountUsageResetsAction;
    snapshotFetchedAtMs: number | null;
    now: number;
    onApplied: () => void;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const { summary } = props;
    const expires = summary.nextExpiresAtMs === null ? null : formatResetAtTime(summary.nextExpiresAtMs, props.now);
    const detail = expires === null
        ? null
        : summary.availableCount > 1
            ? t('connectedServicesCollection.usageResetsFirstExpires', { date: expires })
            : t('connectedServicesCollection.usageResetExpires', { date: expires });
    return (
        <View testID={props.testID} style={styles.resets}>
            <Icon name="clock-counter-clockwise" size={13} color={theme.colors.text.secondary} />
            <Text style={styles.text} numberOfLines={1}>
                <Text style={styles.strong}>{t('connectedServicesCollection.usageResetsCount', { count: summary.availableCount })}</Text>
                {detail ? ` · ${detail}` : ''}
            </Text>
            <View style={styles.grow} />
            {props.action ? (
                <UseOnePressable
                    testID={props.testID ? `${props.testID}:use` : undefined}
                    pending={props.action.pending}
                    onPress={props.action.onUse}
                />
            ) : props.legacyServiceId && props.accountId ? (
                <UseOneButton
                    testID={props.testID ? `${props.testID}:use` : undefined}
                    legacyServiceId={props.legacyServiceId}
                    accountId={props.accountId}
                    providerCreditId={summary.providerCreditId}
                    snapshotFetchedAtMs={props.snapshotFetchedAtMs}
                    onApplied={props.onApplied}
                />
            ) : null}
        </View>
    );
});

/** "Use one": mounted only on an account that has a reset, so only those rows resolve a machine. */
const UseOneButton = React.memo(function UseOneButton(props: Readonly<{
    legacyServiceId: ConnectedServiceId;
    accountId: string;
    providerCreditId: string | null;
    snapshotFetchedAtMs: number | null;
    onApplied: () => void;
    testID?: string;
}>) {
    const action = useAccountUsageResetAction({
        legacyServiceId: props.legacyServiceId,
        accountId: props.accountId,
        snapshotFetchedAtMs: props.snapshotFetchedAtMs,
        onApplied: props.onApplied,
    });
    return (
        <UseOnePressable
            testID={props.testID}
            pending={action.pending}
            onPress={() => { void action.use(props.providerCreditId); }}
        />
    );
});

const UseOnePressable = React.memo(function UseOnePressable(props: Readonly<{
    pending: boolean;
    onPress: () => void;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={t('connectedServicesCollection.useOneReset')}
            accessibilityState={{ busy: props.pending }}
            disabled={props.pending}
            hitSlop={8}
            onPress={props.onPress}
            style={styles.link}
        >
            {props.pending ? <ActivitySpinner size={12} color={theme.colors.text.secondary} /> : null}
            <Text style={styles.linkLabel}>{t('connectedServicesCollection.useOne')}</Text>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    lines: {
        gap: 2,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    text: {
        ...Typography.default(),
        flexShrink: 1,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    warning: {
        color: theme.colors.state.warning.foreground,
    },
    strong: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    resets: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        minHeight: 22,
    },
    grow: {
        flex: 1,
    },
    link: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    linkLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.primary,
    },
}));
