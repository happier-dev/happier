import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ConnectedServiceQuotaLimitSelectionV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { projectPoolUsage, type PoolUsage, type PoolUsageFreshness as PoolUsageFreshnessValue } from '../pools/derivePoolUsage';
import { PoolUsageFreshness } from '../pools/PoolUsageFreshness';
import { UsageMeterRow, UsageMeterStack, type UsageMeterSize } from '../usage/UsageMeterRow';
import { OpenableSurface } from './OpenableSurface';
import { ConnectedAccountIdentityText } from '../ConnectedAccountIdentityText';

export type ConnectedServicePoolIndexMember = Readonly<{
    accountId: string;
    title: string;
    enabled: boolean;
    credentialStatus: unknown;
}>;

export type ConnectedServicePoolIndexEntry = Readonly<{
    testID: string;
    title: string;
    /** "Claude · 3 accounts · uses the one with the most left". */
    subtitle: string;
    serviceTitle?: string;
    quotaLimitSelection?: ConnectedServiceQuotaLimitSelectionV1;
    /** The member the pool uses now ("Using Work"); "since" waits for an active-member timestamp. */
    activeTitle: string | null;
    /** When the pool started using that member, when the pool owner reports it for that very member. */
    activeSinceMs: number | null;
    activeAccountId: string | null;
    members: readonly ConnectedServicePoolIndexMember[];
    star: React.ReactNode;
    onOpen: () => void;
}>;

/**
 * A pool on the Connected services index (lab `csvc` C1 row / C2 card): its name and rule, who it uses
 * now, what is left across it (the members' average per window with the earliest reset, derived by the
 * pool owner) and each member's tightest limit. The row opens the pool.
 */
export const ConnectedServicePoolIndexItemView = React.memo(function ConnectedServicePoolIndexItemView(props: ConnectedServicePoolIndexEntry & Readonly<{
    usage: PoolUsage | null;
    freshness?: PoolUsageFreshnessValue;
    presentation: 'row' | 'card';
    compact: boolean;
    now: number;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { usage } = props;
    const card = props.presentation === 'card';
    const meterSize: UsageMeterSize = card ? 'card' : 'default';
    // A stack of meters is taller than one control: it keeps the row's padding and the row grows around it.
    const rowPadding = usePageRowMetrics().paddingVerticalPx;
    const using = props.activeTitle ? (
        <View style={styles.using}>
            <View style={[styles.usingRing, { borderColor: theme.colors.text.tertiary }]} />
            <ConnectedAccountIdentityText
                value={props.activeSinceMs !== null
                    ? t('connectedServicesPool.usingSince', { name: props.activeTitle, time: formatAsOfTime(props.activeSinceMs, props.now) })
                    : t('connectedServicesCollection.poolUsing', { account: props.activeTitle })}
                style={styles.usingText}
                numberOfLines={1}
            />
        </View>
    ) : null;
    const identity = (
        <View style={styles.identityText}>
            <Text style={styles.title} numberOfLines={1}>{props.title}</Text>
            <Text style={styles.subtitle} numberOfLines={2}>{props.subtitle}</Text>
            {using}
            {props.freshness ? <PoolUsageFreshness freshness={props.freshness} serviceTitle={props.serviceTitle ?? props.title} /> : null}
        </View>
    );
    const chips = card && usage ? (
        <View style={styles.members}>
            {props.members.map((member) => {
                const pct = usage.memberByAccountId[member.accountId]?.lowestRemainingPct ?? null;
                const tone = pct === null ? 'neutral' : resolveQuotaTone(pct);
                const color = tone === 'danger' ? theme.colors.state.danger.textForeground
                    : tone === 'warning' ? theme.colors.state.warning.textForeground : theme.colors.text.primary;
                const active = member.accountId === props.activeAccountId;
                return (
                    <Text
                        key={member.accountId}
                        testID={`${props.testID}:member:${member.accountId}`}
                        style={[styles.member, styles.memberChip, active ? styles.memberActive : null]}
                        numberOfLines={1}
                    >
                        <ConnectedAccountIdentityText value={member.title} style={styles.member} />
                        {' '}
                        <Text style={[styles.memberPct, { color }]}>{pct === null ? '—' : `${Math.round(pct)}%`}</Text>
                    </Text>
                );
            })}
        </View>
    ) : null;
    const meters = usage && usage.windows.length > 0 ? (
        <UsageMeterStack testID={`${props.testID}:meters`}>
            {usage.windows.map((window) => (
                <UsageMeterRow
                    key={window.key}
                    label={window.label}
                    remainingPct={window.remainingPct}
                    resetsAt={window.resetsAt}
                    tone={resolveQuotaTone(window.remainingPct)}
                    estimated={window.estimated}
                    // "next in 10d 22h" outgrows a list row's reset column; the row reads like the account rows above it.
                    resetPrefix={card ? 'next' : undefined}
                    size={meterSize}
                    now={props.now}
                />
            ))}
        </UsageMeterStack>
    ) : usage && props.members.length > 0 && usage.room.reporting === 0 && usage.room.unreported === 0 ? (
        <Text style={styles.subtitle}>{t('common.unavailable')}</Text>
    ) : null;
    const lead = (
        <View style={styles.lead}>
            <Icon name="stack" size={18} color={theme.colors.text.secondary} />
        </View>
    );
    if (card) {
        return (
            <OpenableSurface
                testID={props.testID}
                accessibilityLabel={props.title}
                onPress={props.onOpen}
                style={styles.card}
                hoveredStyle={styles.cardHovered}
            >
                <View pointerEvents="box-none" style={styles.cardTop}>
                    <View pointerEvents="none" style={styles.cardIdentity}>
                        {lead}
                        {identity}
                    </View>
                    {props.star}
                </View>
                <View pointerEvents="none">{meters}</View>
                {chips ? <View pointerEvents="none" style={styles.cardFooter}>{chips}</View> : null}
            </OpenableSurface>
        );
    }
    // A list row is one sheet row like the accounts above it (lab `cr` crHome A): the stack mark, the pool and
    // its rule, who it uses now beneath, and one trailing thing, its limits. The default star and the members'
    // percentages live on the card and the pool page (R138: no per-row actions).
    return (
        <Item
            testID={props.testID}
            title={props.title}
            subtitle={props.subtitle}
            icon={<Icon name="stack" size={18} color={theme.colors.text.secondary} />}
            rightElement={meters ? (
                <View pointerEvents="none" style={props.compact ? null : [styles.use, { marginVertical: rowPadding }]}>{meters}</View>
            ) : undefined}
            rightElementPassive
            keepChevronWithRightElement
            showChevron
            accessoryLayout="adaptive"
            bottomElement={using || props.freshness ? (
                <View style={styles.rowFacts}>
                    {using}
                    {props.freshness ? <PoolUsageFreshness freshness={props.freshness} serviceTitle={props.serviceTitle ?? props.title} /> : null}
                </View>
            ) : undefined}
            bottomElementInset="text"
            showDivider={props.showDivider !== false}
            onPress={props.onOpen}
        />
    );
});

/** The pool with its members' live usage (one batched read, the same store the account rows read). */
export const ConnectedServicePoolIndexItem = React.memo(function ConnectedServicePoolIndexItem(props: ConnectedServicePoolIndexEntry & Readonly<{
    service: QualifiedConnectedAccountRef['service'];
    presentation: 'row' | 'card';
    compact: boolean;
    showDivider?: boolean;
}>) {
    const { service, members } = props;
    const refs = React.useMemo(
        () => members.map((member) => ({ ref: { service, accountId: member.accountId } })),
        [members, service],
    );
    const quotas = useConnectedServiceQuotaSnapshots(refs);
    const summary = React.useMemo(() => {
        const quotaByAccountId = new Map(quotas.profiles.flatMap((profile) => profile.kind === 'qualified'
            ? [[profile.ref.accountId, { snapshot: quotas.snapshotsByKey[profile.key] ?? null, failed: Boolean(quotas.errorsByKey[profile.key]) }] as const]
            : []));
        return projectPoolUsage({
            members: members.map((member) => ({
                accountId: member.accountId,
                enabled: member.enabled,
                credentialStatus: member.credentialStatus,
                snapshot: quotaByAccountId.get(member.accountId)?.snapshot ?? null,
                failed: quotaByAccountId.get(member.accountId)?.failed,
            })),
            quotaLimitSelection: props.quotaLimitSelection,
            // The derivation follows the snapshots; a reset that passes is read on their next update.
            now: Date.now(),
        });
    }, [members, props.quotaLimitSelection, quotas.profiles, quotas.snapshotsByKey, quotas.errorsByKey]);
    return <ConnectedServicePoolIndexItemView {...props} usage={summary.usage} freshness={summary.freshness} now={Date.now()} />;
});

const styles = StyleSheet.create((theme) => ({
    rowFacts: {
        gap: theme.space.s2,
    },
    lead: {
        paddingTop: theme.space.s2,
    },
    identityText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.variant('meta'),
        marginTop: 1,
        color: theme.colors.text.secondary,
    },
    using: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        marginTop: 3,
    },
    usingRing: {
        width: 10,
        height: 10,
        borderRadius: 5,
        borderWidth: 1.5,
    },
    usingText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.primary,
    },
    use: {
        width: 364,
        flexShrink: 1,
        minWidth: 0,
        paddingTop: theme.space.s2,
        gap: theme.space.s10,
    },
    members: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 14,
        rowGap: theme.space.s6,
    },
    member: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
    memberActive: {
        color: theme.colors.text.primary,
    },
    memberChip: {
        paddingHorizontal: theme.space.s6,
        paddingVertical: theme.space.s2,
        borderRadius: 6,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.inset,
    },
    memberPct: {
        ...Typography.default('semiBold'),
        fontVariant: ['tabular-nums'],
    },
    // As tall as what it holds: cards in a row do not stretch to the tallest (lab C2).
    card: {
        minWidth: 0,
        gap: theme.space.s10,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s12,
        paddingHorizontal: 14,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.sectionTint,
    },
    cardTop: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
    },
    cardIdentity: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
    },
    cardHovered: {
        borderColor: theme.colors.border.strong,
    },
    cardFooter: {
        paddingTop: theme.space.s10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
}));
