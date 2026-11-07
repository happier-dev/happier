import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import {
    GestureDetector,
    type ComposedGesture,
    type GestureType,
} from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ExpandableItem, type ExpandableItemHeaderState } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroupColumn } from '@/components/ui/lists/ItemGroupColumns';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ItemSection } from '@/components/ui/lists/ItemSection';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Switch } from '@/components/ui/forms/Switch';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Text } from '@/components/ui/text/Text';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { useNowMs } from '@/hooks/time/useNowMs';
import { Modal } from '@/modal';
import type { QuotaResetRow } from '@/sync/domains/connectedServices/buildQuotaResetRows';
import { resolveConnectedServiceQuotaMeterDetailLabel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { resolveSubscriptionEndTime } from '@/sync/domains/connectedServices/resolveSubscriptionEndTime';
import {
    isConnectedServiceItemCollapsed,
    resolveConnectedServiceCollapseKey,
    setConnectedServiceItemCollapsed,
} from '@/sync/domains/connectedServices/resolveConnectedServiceCollapseKey';
import { useSettingMutable } from '@/sync/store/hooks';
import type { ConnectedServiceCredentialHealthStatusV1, ConnectedServiceId } from '@happier-dev/protocol';
import type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol';
import { t } from '@/text';

import { GAUGE_LABEL_FORMATTER, type AccountUsageRow, type CapacityRingDatum } from './accountBlockModel';
import { ConnectedServiceCapacityAvatar, CONNECTED_SERVICE_GAUGE_BOX, CONNECTED_SERVICE_GAUGE_SIZE } from '../ConnectedServiceCapacityAvatar';
import { Icon } from '@/components/ui/icons/Icon';

export type AccountBlockVariant = 'detail' | 'poolMember';

/**
 * Quota-derived presentation data for `AccountBlock`. Lives as a single object so
 * the collapsed signals, expanded USAGE/RESETS, capacity, and health dot all draw
 * from ONE snapshot. `null` means the quotas feature is off (fail-closed): no
 * meters, resets, capacity, or quota-derived health.
 */
export type AccountBlockQuotaView = Readonly<{
    loading: boolean;
    hasSnapshot: boolean;
    nowMs: number;
    isStale: boolean;
    /** Whether refresh updates the same source currently displayed in this block. */
    canRefresh: boolean;
    /** True while a force-refresh is in flight (drives the refreshing indicator). */
    isRefreshing: boolean;
    /** Latest action/load error (consume failure, load failure) for inline display. */
    error: string | null;
    /** Trigger a force-refresh of this account's quota snapshot. */
    refresh: () => Promise<void>;
    planLabel: string | null;
    usageRows: ReadonlyArray<AccountUsageRow>;
    capacityPct: number | null;
    capacityRings: ReadonlyArray<CapacityRingDatum>;
    resetRows: ReadonlyArray<QuotaResetRow>;
    resetAvailableCount: number;
    pinnedMeterIds: ReadonlyArray<string>;
    togglePinnedMeter: (meterId: string) => void;
    consumeRecoveryCredit: (providerCreditId?: string | null) => Promise<void>;
    consumeRecoveryCreditPending: boolean;
    consumeRecoveryCreditPendingTarget: Readonly<{ providerCreditId: string | null }> | null;
    canConsume: boolean;
    subscription: ProviderAccountSubscriptionV1 | null;
}>;

export interface AccountBlockViewProps {
    serviceId: ConnectedServiceId;
    profileId: string;
    title: string;
    /** Identity line (e.g. provider email) shown when expanded. */
    identityLabel?: string | null;
    status?: ConnectedServiceCredentialHealthStatusV1 | null;
    isDefault?: boolean;
    onToggleDefault?: () => void;
    /** Pool membership chip labels. */
    poolLabels?: ReadonlyArray<string>;
    /** Header kebab actions. */
    actions?: ReadonlyArray<ItemAction>;
    variant?: AccountBlockVariant;
    /** poolMember: owning pool id (namespaces collapse + reorder). */
    groupId?: string | null;
    /** poolMember: member enabled state + toggle. */
    enabled?: boolean;
    onToggleEnabled?: (next: boolean) => void;
    /** poolMember: whether this member is the pool's currently-active account. */
    isActive?: boolean;
    /** poolMember: select this member as the active account (leading radio). */
    onSetActive?: () => void;
    /**
     * poolMember: inline drag-reorder pan gesture for this row. Rendered INLINE
     * inside a `GestureDetector` in the trailing cluster (mirroring `SessionItem`),
     * never passed down as a pre-built element — that element-through-memo path
     * crashes RNGH's web wrapper under React 19 + RNGH 2.28.
     */
    reorderGesture?: GestureType | ComposedGesture;
    showDivider?: boolean;
    testID?: string;
    quota: AccountBlockQuotaView | null;
}

const CHEVRON_SIZE = 16;

const stylesheet = StyleSheet.create((theme) => ({
    // Trailing drag handle for pool members — mirrors SessionItem's
    // `rowActionButton`. `cursor: 'pointer'` is the only interactive web cursor
    // in RN's `CursorValue` union and is ignored on native.
    reorderHandle: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
        cursor: 'pointer',
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
    titleText: {
        color: theme.colors.text.primary,
        fontWeight: '600',
        flexShrink: 1,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 4,
    },
    metaCount: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
    },
    metaCountText: {
        color: theme.colors.text.tertiary,
        fontSize: 12,
    },
    rightCluster: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    body: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        paddingTop: 4,
        gap: 12,
    },
    skeleton: {
        height: 44,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    // Spinner box that replaces the capacity gauge while a force-refresh runs.
    avatarRefreshing: {
        width: CONNECTED_SERVICE_GAUGE_SIZE,
        height: CONNECTED_SERVICE_GAUGE_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Live USAGE/RESETS dim (+ become non-interactive) during a refresh.
    refreshingDim: {
        opacity: 0.5,
    },
    // Inter-section spacing (USAGE ↔ RESETS ↔ error). This wrapper sits between the
    // body and the sections, so it must carry the gap itself — otherwise the sections
    // collapse flush (the body's gap only spaces this wrapper from the Pools section).
    usageSections: {
        gap: 12,
    },
    resetsHint: {
        paddingHorizontal: 16,
        paddingBottom: 6,
    },
    errorText: {
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
        paddingHorizontal: 16,
        paddingTop: 4,
    },
    usageHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 4,
    },
    usageLabel: {
        color: theme.colors.text.primary,
        fontSize: 13,
        flexShrink: 1,
    },
    subscriptionSummary: {
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 18,
        fontWeight: '600',
    },
    subscriptionMeta: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    subscriptionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 6,
    },
    subscriptionStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    subscriptionStatusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    subscriptionStatusDotOn: {
        backgroundColor: theme.colors.state.success.foreground,
    },
    subscriptionStatusDotOff: {
        backgroundColor: theme.colors.text.tertiary,
    },
    subscriptionStatusDotUnknown: {
        backgroundColor: theme.colors.state.warning.foreground,
    },
    resetRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    resetLabel: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        flexShrink: 1,
    },
    resetDetails: {
        flex: 1,
    },
    useAction: {
        color: theme.colors.text.link,
        fontWeight: '600',
    },
    useActionDisabled: {
        color: theme.colors.text.disabled,
        fontWeight: '600',
    },
    poolsSection: {
        gap: 6,
    },
    poolsCaptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 16,
    },
    poolChips: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        paddingHorizontal: 16,
    },
}));

const ACCOUNT_USAGE_COUNTDOWN_TICK_MS = 1_000;

/**
 * One USAGE meter's detail caption. It owns the shared one-second clock, so the open account view
 * counts its reset down live without re-rendering the whole block.
 */
const AccountUsageMeterDetail = React.memo(function AccountUsageMeterDetail(props: Readonly<{
    testID: string;
    row: AccountUsageRow;
    captionStyle: React.ComponentProps<typeof Text>['style'];
}>) {
    const nowMs = useNowMs(ACCOUNT_USAGE_COUNTDOWN_TICK_MS);
    const detailLabel = resolveConnectedServiceQuotaMeterDetailLabel({
        remainingPct: props.row.remainingPct,
        resetAtMs: props.row.resetAtMs,
        nowMs,
        formatter: GAUGE_LABEL_FORMATTER,
    });
    if (props.row.remaining === null) return <Text style={props.captionStyle}>{detailLabel}</Text>;
    return (
        <MeterBar
            testID={props.testID}
            tone={props.row.tone}
            // Remaining-first fill: matches the row's "% left" label and the
            // capacity rings (battery model — see accountBlockModel).
            fillFraction={props.row.remaining}
            caption={detailLabel}
        />
    );
});

function formatResetExpiryDate(expiresAtMs: number): string {
    try {
        return new Date(expiresAtMs).toLocaleDateString();
    } catch {
        return String(expiresAtMs);
    }
}

function resolveResetRowLabel(row: QuotaResetRow): string {
    if (row.expiresAtMs == null) {
        return row.canUse ? t('connectedServices.account.resets.available') : t('common.unavailable');
    }
    return t('connectedServices.account.resets.rowLabel', {
        date: formatResetExpiryDate(row.expiresAtMs),
        countdown: row.countdownLabel ?? '',
    });
}

function resolveResetLimitLabel(providerLimitId: string): string {
    if (providerLimitId === 'five_hour') return t('connectedServices.account.resets.fiveHourLimit');
    if (providerLimitId === 'seven_day') return t('connectedServices.account.resets.weeklyLimit');
    return providerLimitId;
}

function resolveResetUnavailableLabel(row: QuotaResetRow): string {
    const reason = row.details?.unavailableReason;
    return reason
        ? t(`connectedServices.account.resets.unavailableReasons.${reason}`)
        : t('common.unavailable');
}

function resolveSubscriptionStatusLabel(subscription: ProviderAccountSubscriptionV1): string {
    if (subscription.status === 'none') return t('connectedServices.subscription.none');
    if (subscription.status === 'unavailable') return t('connectedServices.subscription.unavailable');
    if (subscription.renewal === 'on') return t('connectedServices.subscription.renewalOn');
    if (subscription.renewal === 'off') return t('connectedServices.subscription.renewalOff');
    return t('connectedServices.subscription.renewalUnknown');
}

function resolveSubscriptionEndsLabel(nowMs: number, endAtMs: number): string {
    const endTime = resolveSubscriptionEndTime({
        nowMs,
        endAtMs,
        formatDate: (value) => new Date(value).toLocaleDateString(),
    });
    return endTime.kind === 'relativeDays'
        ? t('connectedServices.subscription.endsInDays', { days: endTime.days })
        : t('connectedServices.subscription.ends', { date: endTime.date });
}

export const AccountBlockView = React.memo<AccountBlockViewProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const isWeb = Platform.OS === 'web';
    const variant = props.variant ?? 'detail';
    const isPoolMember = variant === 'poolMember';
    const quota = props.quota;
    const poolLabels = props.poolLabels ?? [];
    const actions = props.actions ?? [];
    const testID = props.testID ?? defaultAccountBlockTestID(props);

    // --- collapse persistence (AccountBlock owns this; the hook owns quota) ---
    const [collapsedKeys, setCollapsedKeys] = useSettingMutable('connectedServicesCollapsedItemKeysV1');
    const defaultCollapsed = isPoolMember;
    const collapseKey = resolveConnectedServiceCollapseKey({
        serviceId: props.serviceId,
        profileId: props.profileId,
        groupId: isPoolMember ? props.groupId : null,
    });
    const collapsed = isConnectedServiceItemCollapsed(collapsedKeys, collapseKey, defaultCollapsed);
    const expanded = !collapsed;
    const onExpandedChange = React.useCallback((next: boolean) => {
        setCollapsedKeys(setConnectedServiceItemCollapsed(collapsedKeys, collapseKey, !next, defaultCollapsed));
    }, [collapsedKeys, collapseKey, defaultCollapsed, setCollapsedKeys]);

    const onUseReset = React.useCallback(async (row: QuotaResetRow) => {
        if (!quota || !row.canUse || !quota.canConsume || quota.consumeRecoveryCreditPending) return;
        const confirmed = await Modal.confirm(
            t('connectedServices.account.resets.confirmTitle'),
            t('connectedServices.account.resets.confirmMessage'),
            { confirmText: t('connectedServices.account.resets.confirmCta') },
        );
        if (!confirmed) return;
        // Redeem THIS row's specific credit (per-credit "Use"). The aggregate
        // placeholder row carries `consumableCreditId: null`, which the hook reads
        // as "consume the summary default".
        await quota.consumeRecoveryCredit(row.consumableCreditId);
    }, [quota]);

    // Grabbing the inline drag handle must NOT toggle the header disclosure. The
    // handle's GestureDetector sits inside the header's pressable, so on web a
    // pointer-down on the handle would otherwise also fire the header `onPress`.
    // Mirror SessionItem's `suppressNextRowPressTemporarily`: a ref-flag set on the
    // handle's pointer lifecycle that the header press reads + clears once.
    const suppressNextHeaderPressRef = React.useRef(false);
    const suppressNextHeaderPress = React.useCallback(() => {
        suppressNextHeaderPressRef.current = true;
    }, []);

    // One concentric ring per usage limit (most-constrained outermost); the center
    // number is the overall capacity. No brand glyph/dot — every row here is the
    // same provider, so the logo would be noise.
    const capacityRings = quota?.capacityRings ?? [];
    // A first snapshot that is still loading (no cached value yet) must read as
    // "loading" on the gauge, not as an empty "no usage" ring. This mirrors the
    // body skeleton's `loading && !hasSnapshot` signal so the avatar and body agree.
    const quotaFirstLoad = quota != null && quota.loading && !quota.hasSnapshot;
    // While a force-refresh is in flight, the capacity gauge is replaced by a
    // spinner in place (the live USAGE/RESETS below dim) — so the user sees the
    // refresh working and then the new values land directly when it resolves.
    const leadingIcon = quota?.isRefreshing ? (
        <View testID={`${testID}:refreshing`} style={styles.avatarRefreshing}>
            <ActivitySpinner size={20} />
        </View>
    ) : (
        <ConnectedServiceCapacityAvatar
            testID={`${testID}:avatar`}
            rings={capacityRings}
            loading={quotaFirstLoad}
            centerLabel={quota?.capacityPct != null ? String(Math.round(quota.capacityPct)) : null}
            accessibilityLabel={props.title}
        />
    );

    // The title line stays calm: name + a small star glyph when this is the default
    // account (accounts only — pool members surface "active" via a leading radio) +
    // a status pill ONLY when the credential is unhealthy. Plan moved to the
    // subtitle; pool membership moved to the meta line / body "Pools" section.
    const titleNode = (
        <View style={styles.titleRow}>
            <Text style={styles.titleText} numberOfLines={1}>{props.title}</Text>
            {!isPoolMember && props.isDefault ? (
                <Icon
                    testID={`${testID}:default-star`}
                    name="star"
                    size={14}
                    color={theme.colors.button.primary.background}
                />
            ) : null}
            {props.status === 'needs_reauth' ? (
                <StatusPill
                    testID={`${testID}:reauth-badge`}
                    variant="danger"
                    label={t('connectedServices.detail.profiles.needsReauth')}
                />
            ) : null}
        </View>
    );

    // The plan becomes a muted subtitle ("Pro · email") instead of a title-row pill.
    const planLabel = quota?.planLabel ?? null;
    const identityLabel = props.identityLabel ?? null;
    const identitySubtitle = planLabel && identityLabel
        ? t('connectedServices.account.planEmailSubtitle', { plan: planLabel, email: identityLabel })
        : identityLabel ?? (planLabel ? t('connectedServices.quota.planLabel', { plan: planLabel }) : undefined);

    // The calm meta line (collapsed only): muted resets + pools counts. Per-limit
    // usage now reads from the avatar's concentric capacity rings.
    const poolsCount = poolLabels.length;
    const refreshStatus = quota?.isRefreshing ? (
        <Text testID={`${testID}:refresh-status`} style={styles.metaCountText} accessibilityLiveRegion="polite">
            {t('connectedServices.quota.refreshing')}
        </Text>
    ) : null;
    const renderMetaLine = () => (
        <View style={styles.metaRow}>
            {refreshStatus}
            {quota && quota.resetAvailableCount > 0 ? (
                <View testID={`${testID}:resets`} style={styles.metaCount}>
                    <Icon name="arrow-clockwise" size={11} color={theme.colors.text.tertiary} />
                    <Text style={styles.metaCountText}>
                        {t('connectedServices.quota.recoveryCreditBadge', { count: quota.resetAvailableCount })}
                    </Text>
                </View>
            ) : null}
            {quota?.subscription?.renewal === 'off' && typeof quota.subscription.currentPeriodEndAtMs === 'number' ? (
                <View testID={`${testID}:subscription-end`} style={styles.metaCount}>
                    <Text style={styles.metaCountText}>
                        {resolveSubscriptionEndsLabel(quota.nowMs, quota.subscription.currentPeriodEndAtMs)}
                    </Text>
                </View>
            ) : null}
            {!isPoolMember && poolsCount > 0 ? (
                <View testID={`${testID}:pools-count`} style={styles.metaCount}>
                    <Icon name="git-branch" size={11} color={theme.colors.text.tertiary} />
                    <Text style={styles.metaCountText}>
                        {t('connectedServices.account.poolsCount', { count: poolsCount })}
                    </Text>
                </View>
            ) : null}
        </View>
    );

    const renderRightCluster = (isExpanded: boolean) => (
        <View style={styles.rightCluster}>
            {isPoolMember ? (
                // The active-account radio: always shown for members as the active
                // indicator; tappable only when switching is allowed (`onSetActive`
                // provided and not already active).
                <Pressable
                    testID={`${testID}:active-radio`}
                    hitSlop={8}
                    disabled={(props.isActive ?? false) || props.onSetActive == null}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        props.onSetActive?.();
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{
                        checked: props.isActive ?? false,
                        disabled: (props.isActive ?? false) || props.onSetActive == null,
                    }}
                    accessibilityLabel={t(props.isActive
                        ? 'connectedServices.account.activeMemberA11y'
                        : 'connectedServices.account.setActiveA11y')}
                >
                    <Icon
                        name={props.isActive ? 'radio-button' : 'circle'}
                        size={20}
                        color={props.isActive ? theme.colors.button.primary.background : theme.colors.text.tertiary}
                    />
                </Pressable>
            ) : null}
            {isPoolMember ? (
                <Switch
                    testID={`${testID}:enable-toggle`}
                    value={props.enabled ?? true}
                    onValueChange={props.onToggleEnabled}
                    accessibilityLabel={t('connectedServices.account.memberEnabledLabel')}
                    compact
                />
            ) : null}
            {props.onToggleDefault ? (
                <Pressable
                    testID={`${testID}:default-toggle`}
                    hitSlop={10}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        props.onToggleDefault?.();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={t(props.isDefault
                        ? 'connectedServices.detail.actions.unsetDefault'
                        : 'connectedServices.detail.actions.setDefault')}
                >
                    <Icon
                        name="star"
                        size={16}
                        color={props.isDefault ? theme.colors.button.primary.background : theme.colors.text.secondary}
                        weight={props.isDefault ? 'fill' : 'regular'}
                    />
                </Pressable>
            ) : null}
            {!isPoolMember && quota?.canRefresh ? (
                // Dedicated force-refresh control: pulls a fresh quota snapshot
                // (server refresh + poll) and the row's gauge/USAGE/RESETS update
                // directly when it lands. This is the ONLY refresh affordance — the
                // reconnect action lives in the overflow menu with its own glyph, so
                // a refresh icon now means refresh.
                <Pressable
                    testID={`${testID}:refresh`}
                    hitSlop={10}
                    disabled={quota.isRefreshing}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        void quota.refresh();
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: quota.isRefreshing, busy: quota.isRefreshing }}
                    accessibilityLabel={t('connectedServices.account.refreshA11y')}
                >
                    {quota.isRefreshing ? (
                        <ActivitySpinner size={16} />
                    ) : (
                        <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />
                    )}
                </Pressable>
            ) : null}
            {actions.length > 0 ? (
                // Every account-row secondary action (open / edit label / replace
                // token / RECONNECT / disconnect for accounts; move / set-active /
                // remove for pool members) collapses into ONE ⋮ overflow menu rather
                // than inline icons, so the row stays clean and the advanced reconnect
                // action reads as a menu item — never a refresh-looking inline glyph
                // competing with the dedicated refresh control. `compactThreshold:
                // Infinity` forces the always-overflow layout (the canonical kebab).
                <ItemRowActions
                    title={props.title}
                    actions={[...actions]}
                    iconSize={18}
                    compactThreshold={Number.POSITIVE_INFINITY}
                    compactActionIds={[]}
                    overflowTriggerTestID={`${testID}:actions-menu`}
                />
            ) : null}
            {isPoolMember && props.reorderGesture ? (
                // Rendered INLINE (not threaded as a pre-built element) so the
                // GestureDetector mounts in the same render pass as the row —
                // mirroring SessionItem, the only pattern proven to survive RNGH's
                // web wrapper under React 19 + RNGH 2.28.
                <GestureDetector gesture={props.reorderGesture}>
                    <View
                        testID={`${testID}:reorder-handle`}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        onPointerDown={isWeb ? suppressNextHeaderPress : undefined}
                        onPointerUp={isWeb ? suppressNextHeaderPress : undefined}
                        onPointerCancel={isWeb ? suppressNextHeaderPress : undefined}
                        style={styles.reorderHandle}
                    >
                        <Icon
                            name="list"
                            size={20}
                            color={theme.colors.text.tertiary}
                        />
                    </View>
                </GestureDetector>
            ) : null}
            <Icon
                name={isExpanded ? 'caret-down' : 'caret-right'}
                size={CHEVRON_SIZE}
                color={theme.colors.text.secondary}
            />
        </View>
    );

    // The trailing cluster hosts its own interactive controls (enable switch,
    // star toggle, kebab, drag handle). On web each renders a nested `<button>`,
    // and a header `Item` with `accessibilityRole='button'` is itself a `<button>`
    // — yielding the invalid "<button> inside <button>" DOM nesting. When the
    // header hosts interactive children, render it with a non-button web role
    // (`role="group"`); it stays pressable (expand-on-press) and keeps its
    // bridged `aria-expanded`, but is no longer a button element. Inner controls
    // already `stopPropagation`, so they never also toggle the disclosure.
    const hasInteractiveTrailing = (isPoolMember && props.onToggleEnabled != null)
        || (isPoolMember && props.onSetActive != null)
        || props.onToggleDefault != null
        || (!isPoolMember && quota?.canRefresh === true)
        || actions.length > 0
        || (isPoolMember && props.reorderGesture != null);

    const renderHeader = (state: ExpandableItemHeaderState) => {
        const onHeaderPress = () => {
            // A grab on the drag handle suppresses the immediately-following header
            // press exactly once (web), so dragging never collapses/expands the row.
            if (suppressNextHeaderPressRef.current) {
                suppressNextHeaderPressRef.current = false;
                return;
            }
            state.headerProps.onPress();
        };
        return (
            <Item
                testID={`${testID}:header`}
                {...state.headerProps}
                onPress={onHeaderPress}
                webRole={isWeb && hasInteractiveTrailing ? 'group' : undefined}
                accessibilityLabel={props.title}
                title={titleNode}
                subtitle={identitySubtitle}
                subtitleAccessory={state.expanded ? refreshStatus : renderMetaLine()}
                subtitleLines={1}
                leftElement={leadingIcon}
                iconBoxSize={CONNECTED_SERVICE_GAUGE_BOX}
                rightElement={renderRightCluster(state.expanded)}
                showChevron={false}
            />
        );
    };

    const usageContent = quota && quota.loading && !quota.hasSnapshot ? (
        <View testID={`${testID}:usage-skeleton`} style={styles.skeleton} />
    ) : quota ? (
        <View
            style={[styles.usageSections, quota.isRefreshing && styles.refreshingDim]}
            pointerEvents={quota.isRefreshing ? 'none' : 'auto'}
        >
            {quota.subscription ? (
                <ItemSection testID={`${testID}:subscription`}>
                    <ItemGroupColumn span={2}>
                        <View testID={`${testID}:subscription:header`} style={styles.subscriptionHeader}>
                            <Eyebrow>{t('connectedServices.subscription.title')}</Eyebrow>
                            <View style={styles.subscriptionStatus}>
                                <View style={[
                                    styles.subscriptionStatusDot,
                                    quota.subscription.renewal === 'on'
                                        ? styles.subscriptionStatusDotOn
                                        : quota.subscription.renewal === 'off'
                                            ? styles.subscriptionStatusDotOff
                                            : styles.subscriptionStatusDotUnknown,
                                ]} />
                                <Text testID={`${testID}:subscription:renewal`} style={styles.subscriptionSummary}>
                                    {resolveSubscriptionStatusLabel(quota.subscription)}
                                </Text>
                            </View>
                        </View>
                        {typeof quota.subscription.currentPeriodEndAtMs === 'number' ? (
                            <Text testID={`${testID}:subscription:period`} style={styles.subscriptionMeta}>
                                {resolveSubscriptionEndsLabel(quota.nowMs, quota.subscription.currentPeriodEndAtMs)}
                            </Text>
                        ) : null}
                    </ItemGroupColumn>
                </ItemSection>
            ) : null}

            {quota.usageRows.length > 0 ? (
                <ItemSection testID={`${testID}:usage`} caption={t('connectedServices.account.usageCaption')}>
                    {quota.usageRows.map((row) => (
                        <ItemGroupColumn key={row.meterId}>
                            <View>
                                <View style={styles.usageHeaderRow}>
                                    <Text style={styles.usageLabel} numberOfLines={1}>{row.label}</Text>
                                    <Pressable
                                        testID={`${testID}:pin:${row.meterId}`}
                                        hitSlop={10}
                                        onPress={() => quota.togglePinnedMeter(row.meterId)}
                                        accessibilityRole="button"
                                        accessibilityLabel={row.label}
                                    >
                                        <Icon
                                            name="bookmark"
                                            size={16}
                                            color={quota.pinnedMeterIds.includes(row.meterId)
                                                ? theme.colors.text.primary
                                                : theme.colors.text.secondary}
                                            />
                                    </Pressable>
                                </View>
                                <AccountUsageMeterDetail
                                    testID={`${testID}:meter:${row.meterId}`}
                                    row={row}
                                    captionStyle={styles.subscriptionMeta}
                                />
                            </View>
                        </ItemGroupColumn>
                    ))}
                </ItemSection>
            ) : null}

            {quota.resetRows.length > 0 ? (
                <ItemSection testID={`${testID}:resets`} caption={t('connectedServices.account.resetsCaption')}>
                    {!quota.canConsume && quota.resetRows.some((row) => row.canUse) ? (
                        // Explain WHY "Use" is inert (the reachable disabled cause is
                        // no resolvable target machine) instead of a silent dead button.
                        <ItemGroupColumn span={2}>
                            <Eyebrow testID={`${testID}:resets-hint`} style={styles.resetsHint}>
                                {t('connectedServices.quota.recoveryCreditMachineUnavailable')}
                            </Eyebrow>
                        </ItemGroupColumn>
                    ) : null}
                    {quota.resetRows.map((row) => {
                        const rowPending = row.canUse && quota.consumeRecoveryCreditPendingTarget !== null
                            && quota.consumeRecoveryCreditPendingTarget.providerCreditId === row.consumableCreditId;
                        const useDisabled = !row.canUse || !quota.canConsume || quota.consumeRecoveryCreditPending;
                        const remainingCountLabel = row.details
                            ? t('connectedServices.account.resets.remainingCount', { count: row.details.remainingCount })
                            : null;
                        return (
                            <ItemGroupColumn key={row.key}>
                                <View testID={`${testID}:reset-row:${row.key}`} style={styles.resetRow}>
                                    <View style={styles.resetDetails}>
                                        <Text
                                            testID={row.details && !row.title ? `${testID}:reset-count:${row.key}` : undefined}
                                            style={styles.resetLabel}
                                        >{row.title ?? remainingCountLabel ?? resolveResetRowLabel(row)}</Text>
                                        {(row.title || row.details) && row.expiresAtMs != null ? (
                                            <Text style={styles.resetLabel}>{resolveResetRowLabel(row)}</Text>
                                        ) : null}
                                        {row.description ? <Text style={styles.resetLabel}>{row.description}</Text> : null}
                                        {row.details && row.title ? (
                                            <Text testID={`${testID}:reset-count:${row.key}`} style={styles.resetLabel}>
                                                {remainingCountLabel}
                                            </Text>
                                        ) : null}
                                        {row.details && row.details.appliesToProviderLimitIds.length > 0 ? (
                                            <Text testID={`${testID}:reset-applies-to:${row.key}`} style={styles.resetLabel}>
                                                {t('connectedServices.account.resets.appliesTo', {
                                                    limits: row.details.appliesToProviderLimitIds.map(resolveResetLimitLabel).join(' · '),
                                                })}
                                            </Text>
                                        ) : null}
                                        {!row.canUse && (row.title || row.expiresAtMs != null || row.details) ? (
                                            <Text testID={`${testID}:reset-unavailable:${row.key}`} style={styles.resetLabel}>{resolveResetUnavailableLabel(row)}</Text>
                                        ) : null}
                                    </View>
                                    <Pressable
                                        testID={`${testID}:reset-use:${row.key}`}
                                        disabled={useDisabled}
                                        onPress={() => onUseReset(row)}
                                        accessibilityRole="button"
                                        accessibilityState={{ disabled: useDisabled }}
                                        accessibilityLabel={t('connectedServices.account.resets.use')}
                                    >
                                        {rowPending ? (
                                            <ActivitySpinner size={14} />
                                        ) : (
                                            <Text style={useDisabled ? styles.useActionDisabled : styles.useAction}>
                                                {t('connectedServices.account.resets.use')}
                                            </Text>
                                        )}
                                    </Pressable>
                                </View>
                            </ItemGroupColumn>
                        );
                    })}
                </ItemSection>
            ) : null}

            {quota.error ? (
                <Text testID={`${testID}:quota-error`} style={styles.errorText}>{quota.error}</Text>
            ) : null}
        </View>
    ) : null;

    const body = (usageContent || poolLabels.length > 0) ? (
        <View style={styles.body}>
            {usageContent}
            {poolLabels.length > 0 ? (
                <View testID={`${testID}:body-pools`} style={styles.poolsSection}>
                    <View style={styles.poolsCaptionRow}>
                        <Eyebrow testID={`${testID}:pools-label`}>
                            {t('connectedServices.account.poolsLabel')}
                        </Eyebrow>
                    </View>
                    <View style={styles.poolChips}>
                        {poolLabels.map((label, index) => (
                            <StatusPill
                                key={`${label}:${index}`}
                                testID={`${testID}:body-pool-chip:${index}`}
                                variant="neutral"
                                hideDot
                                label={label}
                            />
                        ))}
                    </View>
                </View>
            ) : null}
        </View>
    ) : null;

    return (
        <ExpandableItem
            testID={testID}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            showDivider={props.showDivider}
            header={renderHeader}
        >
            {body}
        </ExpandableItem>
    );
});

AccountBlockView.displayName = 'AccountBlockView';

export function defaultAccountBlockTestID(params: Readonly<{
    serviceId: string;
    profileId: string;
    variant?: AccountBlockVariant;
    groupId?: string | null;
}>): string {
    if (params.variant === 'poolMember' && params.groupId) {
        return `account-block:pool:${params.groupId}:${params.profileId}`;
    }
    return `account-block:${params.profileId}`;
}
