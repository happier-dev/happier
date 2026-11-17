import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { PlanChecklistRowDetails } from './PlanChecklistRowDetails';
import type {
    PlanChecklistExecutionState,
    PlanChecklistItem,
    PlanChecklistItemStatus,
    PlanChecklistPhase,
    PlanChecklistVariant,
} from './types';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName, type IconWeight } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HappierStepMarkerView } from '@happier-dev/plugin-ui/presentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

function getRowStatus(
    item: PlanChecklistItem,
    phase: PlanChecklistPhase,
    selected: boolean,
    execution?: PlanChecklistExecutionState,
): PlanChecklistItemStatus {
    if (phase === 'select') {
        if (item.satisfied && item.disabled) {
            return 'done';
        }
        if (item.satisfied && selected) {
            return 'done';
        }
        return selected ? 'queued' : 'idle';
    }
    if (phase === 'execute') {
        if (execution?.status) {
            return execution.status;
        }
        if (item.satisfied) {
            return 'done';
        }
        return selected ? 'queued' : 'idle';
    }
    return selected ? 'queued' : 'idle';
}

function getExecutionStatusIcon(status: PlanChecklistItemStatus, selected: boolean): IconName | null {
    if (status === 'running') {
        return null;
    }
    if (status === 'done') {
        return 'check-circle';
    }
    if (status === 'error') {
        return 'x-circle';
    }
    if (status === 'queued') {
        return 'circle';
    }
    if (status === 'idle') {
        return 'circle';
    }
    return null;
}

function getStatusLabel(status: PlanChecklistItemStatus): string | null {
    switch (status) {
        case 'running':
            return t('common.running');
        case 'done':
            return t('common.done');
        case 'error':
            return t('common.error');
        default:
            return null;
    }
}

function normalizeNodeText(node: React.ReactNode): string | null {
    if (typeof node === 'string' || typeof node === 'number') {
        const value = String(node).trim();
        return value.length > 0 ? value : null;
    }
    return null;
}

function shouldSuppressDetailsSummary(item: PlanChecklistItem): boolean {
    const subtitle = normalizeNodeText(item.subtitle);
    const details = typeof item.details === 'function' ? null : normalizeNodeText(item.details);
    if (!subtitle || !details) {
        return false;
    }
    return subtitle === details;
}

function shouldRenderBadge(statusLabel: string | null, badge: React.ReactNode): boolean {
    if (!statusLabel) {
        return true;
    }
    const badgeText = normalizeNodeText(badge);
    if (!badgeText) {
        return true;
    }
    return badgeText !== statusLabel;
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        width: '100%',
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
        backgroundColor: theme.colors.surface.base,
    },
    rowOnboarding: {
        paddingHorizontal: theme.space.s20,
        paddingVertical: 18,
        alignItems: 'flex-start',
        gap: 14,
    },
    rowCompact: {
        paddingVertical: theme.space.s10,
        gap: theme.space.s10,
    },
    rowSelected: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    rowDisabled: {
        opacity: 0.55,
    },
    rowHovered: {
        backgroundColor: theme.colors.surface.inset,
    },
    rowNeedsAttention: {
        backgroundColor: theme.colors.state.attention.background,
    },
    rowContent: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    rowContentOnboarding: {
        alignItems: 'flex-start',
        gap: 14,
    },
    rowContentCompact: {
        gap: theme.space.s10,
    },
    leading: {
        width: 26,
        height: 26,
        alignItems: 'center',
        justifyContent: 'center',
    },
    leadingCompact: {
        width: 22,
        height: 22,
    },
    leadingTimeline: {
        width: 30,
        alignSelf: 'stretch',
        alignItems: 'center',
        position: 'relative',
        paddingTop: 1,
    },
    leadingTimelineCompact: {
        width: 24,
    },
    timelineConnector: {
        position: 'absolute',
        top: 30,
        bottom: -18,
        width: 1,
        backgroundColor: theme.colors.border.default,
    },
    timelineConnectorCompact: {
        top: 24,
        bottom: -10,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    title: {
        color: theme.colors.text.primary,
        ...Typography.variant('heading'),
    },
    titleCompact: {
        fontSize: 13,
        lineHeight: 18,
    },
    subtitle: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    subtitleCompact: {
        fontSize: 12,
        lineHeight: 16,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        flexShrink: 0,
    },
    trailingOnboarding: {
        paddingTop: theme.space.s2,
    },
    statusLabel: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
    },
    statusLabelNeedsAttention: {
        color: theme.colors.state.attention.textForeground,
    },
    badge: {
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s4,
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderRadius: 999,
    },
    badgeText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    detailsToggle: {
        padding: theme.space.s2,
    },
    detailsToggleHidden: {
        opacity: 0,
    },
    detailsToggleSlot: {
        width: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
    detailsControl: {
        position: 'absolute',
        right: theme.space.s16,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
    },
    detailsControlOnboarding: {
        right: theme.space.s20,
        paddingTop: theme.space.s20,
        justifyContent: 'flex-start',
    },
    detailsControlCompact: {
        paddingTop: theme.space.s12,
    },
    details: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    iconBoxBase: {
        width: 26,
        height: 26,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export type PlanChecklistRowProps = Readonly<{
    testID?: string;
    item: PlanChecklistItem;
    variant: PlanChecklistVariant;
    phase: PlanChecklistPhase;
    selected: boolean;
    execution?: PlanChecklistExecutionState;
    expanded: boolean;
    childrenContent?: React.ReactNode;
    depth?: number;
    positionIndex?: number;
    isLast?: boolean;
    onToggle: () => void;
    onToggleExpanded: () => void;
    onCopyDiagnostics?: () => boolean | void | Promise<boolean | void>;
}>;

export const PlanChecklistRow = React.memo(function PlanChecklistRow(props: PlanChecklistRowProps) {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const styles = stylesheet;
    const [hovered, setHovered] = React.useState(false);
    const status = getRowStatus(props.item, props.phase, props.selected, props.execution);
    // A run waiting on the person at this row says so in its place; the question itself is asked once, by the caller.
    const needsAttention = props.phase === 'execute' && props.item.needsAttention === true;
    const statusLabel = props.phase === 'execute' ? (needsAttention ? t('inbox.needsYou') : getStatusLabel(status)) : null;
    const suppressRepeatedDetails = shouldSuppressDetailsSummary(props.item);
    const itemRenderDetails: (() => React.ReactNode) | undefined = React.useMemo(() => {
        if (suppressRepeatedDetails) {
            return undefined;
        }
        if (props.item.renderDetails) {
            return props.item.renderDetails;
        }
        if (typeof props.item.details === 'function') {
            return props.item.details;
        }
        if (props.item.details !== undefined) {
            const details = props.item.details;
            return () => details;
        }
        return undefined;
    }, [props.item.details, props.item.renderDetails, suppressRepeatedDetails]);
    const hasDetailsContent = Boolean(
        itemRenderDetails
        || props.childrenContent
        || (props.execution?.logs?.length ?? 0) > 0
        || props.execution?.error,
    );
    const detailsAvailable = hasDetailsContent;
    const shouldRevealDetailsToggle = detailsAvailable && (Platform.OS !== 'web' || hovered || props.expanded);
    // 'checkmark-circle' (done) and 'checkmark-circle-outline' (selected) both render the same
    // 'check-circle' glyph now; Phosphor expresses the old filled-vs-outline Ionicons pair as a
    // weight, not a name — see iconWeight below.
    const iconName: IconName | null = props.phase === 'select'
        ? (status === 'done' || props.selected ? 'check-circle' : 'circle')
        : getExecutionStatusIcon(status, props.selected);
    const iconWeight: IconWeight | undefined = props.phase === 'select' && status === 'done' ? 'fill' : undefined;
    const canToggleSelection = props.phase === 'select' && !props.item.disabled;
    const canToggleExpanded = detailsAvailable;
    const rowOnPress = React.useMemo(() => {
        if (canToggleSelection) {
            return props.onToggle;
        }
        if (canToggleExpanded) {
            return props.onToggleExpanded;
        }
        return undefined;
    }, [canToggleExpanded, canToggleSelection, props.onToggle, props.onToggleExpanded]);
    const dimRow = props.phase === 'select' && props.item.disabled && props.item.satisfied;
    const statusSlotTestID = props.testID ? `${props.testID}-status-slot` : undefined;
    const usesOnboardingVariant = props.variant === 'onboarding';
    const usesCompactNestedRow = usesOnboardingVariant && (props.depth ?? 0) > 0;
    const timelineNodeIndex = props.positionIndex ?? 1;

    const detailsToggle = detailsAvailable ? (
        <View style={styles.detailsToggleSlot} pointerEvents={shouldRevealDetailsToggle ? 'auto' : 'none'}>
            <Pressable
                testID={props.testID ? `${props.testID}-details-toggle` : undefined}
                accessibilityRole="button"
                accessibilityLabel={t('common.details')}
                accessibilityState={{ expanded: props.expanded }}
                onPress={props.onToggleExpanded}
                style={({ pressed }) => ([
                    styles.detailsToggle,
                    shouldRevealDetailsToggle ? null : styles.detailsToggleHidden,
                    pressed ? { opacity: motionTokens.press.opacity } : null,
                ])}
            >
                <DisclosureCaret expanded={props.expanded} size={16} />
            </Pressable>
        </View>
    ) : null;

    return (
        <View>
            <View {...(Platform.OS === 'web' && detailsAvailable ? {
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
            } : {})}>
            <Pressable
                testID={props.testID}
                accessibilityRole={rowOnPress ? 'button' : undefined}
                accessibilityState={{ busy: props.phase === 'execute' && status === 'running' }}
                disabled={!rowOnPress}
                onPress={rowOnPress}
                style={({ pressed }) => ([
                    styles.row,
                    usesOnboardingVariant ? styles.rowOnboarding : null,
                    usesCompactNestedRow ? styles.rowCompact : null,
                    props.selected ? styles.rowSelected : null,
                    hovered && !props.selected && rowOnPress ? styles.rowHovered : null,
                    pressed && rowOnPress ? { backgroundColor: theme.colors.surface.pressed } : null,
                    dimRow ? styles.rowDisabled : null,
                    needsAttention ? styles.rowNeedsAttention : null,
                ])}
            >
                <View style={[
                    styles.rowContent,
                    usesOnboardingVariant ? styles.rowContentOnboarding : null,
                    usesCompactNestedRow ? styles.rowContentCompact : null,
                ]}>
                    <View style={[
                        usesOnboardingVariant ? styles.leadingTimeline : styles.leading,
                        usesCompactNestedRow ? styles.leadingTimelineCompact : null,
                        !usesOnboardingVariant && usesCompactNestedRow ? styles.leadingCompact : null,
                    ]}>
                        {usesOnboardingVariant && !props.isLast ? (
                            <View style={[
                                styles.timelineConnector,
                                usesCompactNestedRow ? styles.timelineConnectorCompact : null,
                            ]} />
                        ) : null}
                        {usesOnboardingVariant ? <HappierStepMarkerView
                            testID={statusSlotTestID} theme={presentationTheme}
                            marker={status === 'done' || status === 'error' || status === 'running'
                                ? { kind: 'state', state: status === 'done' ? 'passed' : status === 'error' ? 'failed' : 'running', label: getStatusLabel(status) ?? '' }
                                : { kind: 'number', value: timelineNodeIndex }}
                            markerLabel={getStatusLabel(status) ?? undefined}
                            numberState={props.selected ? 'current' : 'upcoming'}
                            stateGlyph={status === 'done' || status === 'error' ? <Icon name={status === 'done' ? 'check' : 'x'} size={12}
                                color={theme.colors.state[status === 'done' ? 'success' : 'danger'].foreground} /> : undefined}
                        /> : <View testID={statusSlotTestID} style={styles.iconBoxBase}>
                            {needsAttention ? (
                                <Icon name="radio-button" size={usesCompactNestedRow ? 16 : (usesOnboardingVariant ? 18 : 16)}
                                    color={theme.colors.state.attention.foreground} />
                            ) : status === 'running' ? (
                                <ActivitySpinner
                                    size={usesCompactNestedRow ? 16 : (usesOnboardingVariant ? 18 : 16)}
                                    color={usesOnboardingVariant ? theme.colors.text.secondary : theme.colors.accent.blue}
                                />
                            ) : iconName ? (
                                    <Icon
                                        name={iconName}
                                        size={usesCompactNestedRow ? 16 : (usesOnboardingVariant ? 18 : 16)}
                                        color={
                                            status === 'done'
                                                ? theme.colors.state.success.foreground
                                                : status === 'error'
                                                    ? theme.colors.state.danger.foreground
                                                    : props.selected
                                                        ? (usesOnboardingVariant ? theme.colors.text.primary : theme.colors.accent.blue)
                                                        : theme.colors.text.tertiary
                                        }
                                        weight={iconWeight}
                                    />
                            ) : null}
                        </View>}
                    </View>

                    <View style={styles.titleColumn}>
                        <Text
                            testID={props.testID ? `${props.testID}-title` : undefined}
                            style={[styles.title, usesCompactNestedRow ? styles.titleCompact : null]}
                            numberOfLines={usesOnboardingVariant ? undefined : 1}
                        >
                            {props.item.title}
                        </Text>
                        {props.item.subtitle ? (
                            <Text
                                testID={props.testID ? `${props.testID}-subtitle` : undefined}
                                style={[styles.subtitle, usesCompactNestedRow ? styles.subtitleCompact : null]}
                                numberOfLines={2}
                            >
                                {props.item.subtitle}
                            </Text>
                        ) : null}
                    </View>
                </View>

                <View style={[styles.trailing, usesOnboardingVariant ? styles.trailingOnboarding : null]}>
                    {statusLabel ? (
                        <Text style={[styles.statusLabel, needsAttention ? styles.statusLabelNeedsAttention : null]}>{statusLabel}</Text>
                    ) : null}
                    {props.item.badge && shouldRenderBadge(statusLabel, props.item.badge) ? (
                        <View style={styles.badge}>
                            {typeof props.item.badge === 'string' ? (
                                <Text style={styles.badgeText}>{props.item.badge}</Text>
                            ) : (
                                props.item.badge
                            )}
                        </View>
                    ) : null}
                    {detailsAvailable ? <View style={styles.detailsToggleSlot} /> : null}
                </View>
            </Pressable>
            {detailsToggle ? (
                <View style={[styles.detailsControl, usesOnboardingVariant ? styles.detailsControlOnboarding : null,
                    usesCompactNestedRow ? styles.detailsControlCompact : null]}>
                    {detailsToggle}
                </View>
            ) : null}
            </View>

            {props.expanded ? (
                <View style={styles.details}>
                    <PlanChecklistRowDetails
                        testID={props.testID ? `${props.testID}-details` : undefined}
                        renderDetails={itemRenderDetails}
                        detailsTitle={null}
                        childrenContent={props.childrenContent}
                        error={props.execution?.error}
                        logs={props.execution?.logs}
                        onCopyDiagnostics={hasDetailsContent ? props.onCopyDiagnostics : undefined}
                    />
                </View>
            ) : null}
        </View>
    );
});
