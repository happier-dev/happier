import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveQuotaMeterTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { t } from '@/text';

import { UsageMeterRow, UsageMeterStack } from '../usage/UsageMeterRow';

/** One window on a member's row, as the summary-meter owner selects it. */
export type PoolMemberMeter = Readonly<{
    meterId: string;
    label: string;
    remainingPct: number | null;
    resetsAt: number | null;
    status: 'ok' | 'unavailable' | 'estimated';
}>;

/** What the row shows beside the member: its limits, a quiet state, or nothing. */
export type PoolMemberUsage =
    | Readonly<{ kind: 'meters'; meters: readonly PoolMemberMeter[] }>
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'off' }>
    | Readonly<{ kind: 'none' }>;

/** A quiet line under the identity: why a member is off, or how old its usage is. */
export type PoolMemberNote = Readonly<{ icon: 'info' | 'clock'; text: string }>;

const LOADING_METERS = ['first', 'second'] as const;
/**
 * Below this row width the meters move under the member's identity (the lab's phone twin) while the
 * switch and › stay beside the name. Compact rows offer the remaining actions by long press;
 * intentional Organize mode supplies the shared drag grip on phones.
 */
const INLINE_USAGE_MIN_ROW_WIDTH_PX = PAGE_LIST_METRICS.rowStackBelowWidthPx;

/**
 * A pool member (lab `csvc` PL, round 3): drag handle (priority), a radio that makes it the active
 * member, its name (Active), who it is (email · plan) and — beside it — its own limits on the one
 * meter; the on/off switch (`enabled`), ⋯ for the rest and › to the account. A switched-off member
 * says it is not used, and one the pool turned off says why.
 */
export const PoolMemberRow = React.memo(function PoolMemberRow(props: Readonly<{
    testID: string;
    title: string;
    identityLabel: string | null;
    active: boolean;
    enabled: boolean;
    note: PoolMemberNote | null;
    usage: PoolMemberUsage;
    now: number;
    /** Null when the member cannot be made active from here (already active, or fallback unavailable). */
    onMakeActive: (() => void) | null;
    onEnabledChange: ((enabled: boolean) => void) | null;
    onOpen: (() => void) | null;
    actions: ReadonlyArray<ItemAction>;
    /** Shared entity handle; intentional Organize mode makes it available on phones. */
    reorderHandle?: React.ReactNode;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { title } = props;
    const [inlineUsage, setInlineUsage] = React.useState(true);
    const [actionsOpen, setActionsOpen] = React.useState(false);
    const openActions = React.useCallback(() => setActionsOpen(true), []);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (!Number.isFinite(width) || width <= 0) return;
        const next = width >= INLINE_USAGE_MIN_ROW_WIDTH_PX;
        setInlineUsage((current) => (current === next ? current : next));
    }, []);

    const usage = props.usage.kind === 'meters' && props.usage.meters.length > 0 ? (
        <UsageMeterStack testID={`${props.testID}:meters`}>
            {props.usage.meters.map((meter) => (
                <UsageMeterRow
                    key={meter.meterId}
                    label={meter.label}
                    remainingPct={meter.remainingPct}
                    resetsAt={meter.resetsAt}
                    tone={resolveQuotaMeterTone(meter)}
                    estimated={meter.status === 'estimated'}
                    now={props.now}
                    size="card"
                />
            ))}
        </UsageMeterStack>
    ) : props.usage.kind === 'loading' ? (
        <UsageMeterStack testID={`${props.testID}:meters-loading`}>
            {LOADING_METERS.map((key) => (
                <UsageMeterRow key={key} label="" remainingPct={null} resetsAt={null} tone="neutral" now={props.now} loading />
            ))}
        </UsageMeterStack>
    ) : props.usage.kind === 'off' ? (
        <Text testID={`${props.testID}:off`} style={styles.quiet} numberOfLines={2}>
            {t('connectedServicesPool.offNotUsed')}
        </Text>
    ) : null;

    const leading = (
        <View style={styles.leading}>
            {props.reorderHandle}
            <Pressable
                testID={`${props.testID}:active-radio`}
                hitSlop={8}
                disabled={props.onMakeActive === null}
                onPress={() => props.onMakeActive?.()}
                accessibilityRole="radio"
                accessibilityState={{ checked: props.active, disabled: props.onMakeActive === null }}
                accessibilityLabel={t('connectedServicesPool.makeActiveA11y', { name: title })}
            >
                <Icon
                    name={props.active ? 'radio-button' : 'circle'}
                    size={20}
                    weight={props.active ? 'fill' : 'regular'}
                    color={props.active ? theme.colors.text.primary : theme.colors.text.tertiary}
                />
            </Pressable>
        </View>
    );

    const row = (
        <View testID={`${props.testID}:layout`} onLayout={onLayout}>
            <Item
                testID={props.testID}
                dataSet={{ entityDragBody: 'true' }}
                onLongPress={(Platform.OS !== 'web' || !inlineUsage) && props.actions.length > 0 ? openActions : undefined}
                onContextMenu={!inlineUsage && props.actions.length > 0 ? (event) => { (event as { preventDefault?: () => void }).preventDefault?.(); setActionsOpen(true); } : undefined}
                accessibilityActions={!inlineUsage ? props.actions.filter((action) => !action.disabled).map((action) => ({ name: action.id, label: action.title })) : undefined}
                onAccessibilityAction={!inlineUsage ? (event) => props.actions.find((action) => action.id === event.nativeEvent.actionName)?.onPress?.() : undefined}
                onKeyDown={!inlineUsage ? (event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault?.(); setActionsOpen(true); } } : undefined}
                title={title}
                titleAccessory={props.active ? (
                    <StatusPill testID={`${props.testID}:active`} variant="neutral" hideDot label={t('connectedServicesPool.active')} />
                ) : undefined}
                titleStyle={props.enabled ? undefined : styles.muted}
                subtitle={props.identityLabel ?? undefined}
                subtitleAccessory={props.note ? (
                    <View testID={`${props.testID}:note`} style={styles.note}>
                        <Icon name={props.note.icon} size={12} color={theme.colors.state.warning.foreground} />
                        <Text style={styles.noteText} numberOfLines={2}>{props.note.text}</Text>
                    </View>
                ) : undefined}
                leftElement={leading}
                bottomElement={!inlineUsage ? usage : undefined}
                rightElement={(
                    <View style={styles.right}>
                        {inlineUsage ? <View style={styles.usage}>{usage}</View> : null}
                        <View style={styles.controls}>
                            <Switch
                                testID={`${props.testID}:enabled`}
                                value={props.enabled}
                                onValueChange={props.onEnabledChange ?? undefined}
                                disabled={props.onEnabledChange === null}
                                accessibilityLabel={t('connectedServicesPool.memberOnA11y', { name: title })}
                                compact
                            />
                            {props.actions.length > 0 ? (
                                <ItemRowActions
                                    title={title}
                                    actions={[...props.actions]}
                                    iconSize={18}
                                    compactThreshold={Number.POSITIVE_INFINITY}
                                    compactActionIds={[]}
                                    overflowTriggerTestID={`${props.testID}:actions-menu`}
                                    overflowOpen={actionsOpen}
                                    onOverflowOpenChange={setActionsOpen}
                                    renderOverflowTrigger={!inlineUsage ? () => null : undefined}
                                />
                            ) : null}
                            {props.onOpen ? (
                                <IconButton
                                    testID={`${props.testID}:open`}
                                    accessibilityLabel={t('connectedServicesPool.openA11y', { name: title })}
                                    iconName="caret-right"
                                    variant="plain"
                                    iconSize={16}
                                    onPress={props.onOpen}
                                />
                            ) : null}
                        </View>
                    </View>
                )}
                rightElementOutsidePressable
                showChevron={false}
                accessoryLayout="inline"
                showDivider={props.showDivider}
            />
        </View>
    );
    return row;
});

const stylesheet = StyleSheet.create((theme) => ({
    leading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    right: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        flexShrink: 1,
        minWidth: 0,
    },
    usage: {
        width: 300,
        maxWidth: '100%',
        flexShrink: 1,
        minWidth: 0,
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    muted: {
        color: theme.colors.text.secondary,
    },
    note: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        marginTop: 3,
    },
    noteText: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.state.warning.foreground,
        flexShrink: 1,
    },
    quiet: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.tertiary,
    },
}));
