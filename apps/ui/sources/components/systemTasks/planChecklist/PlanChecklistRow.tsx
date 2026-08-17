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
        paddingHorizontal: 16,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        backgroundColor: theme.colors.surface.base,
    },
    rowOnboarding: {
        paddingHorizontal: 20,
        paddingVertical: 18,
        alignItems: 'flex-start',
        gap: 14,
    },
    rowCompact: {
        paddingVertical: 10,
        gap: 10,
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
    rowContent: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    rowContentOnboarding: {
        alignItems: 'flex-start',
        gap: 14,
    },
    rowContentCompact: {
        gap: 10,
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
    timelineNode: {
        width: 30,
        height: 30,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.modal,
        backgroundColor: theme.colors.surface.base,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1,
    },
    timelineNodeCompact: {
        width: 24,
        height: 24,
    },
    timelineNodeDone: {
        borderColor: theme.colors.state.success.foreground,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    timelineNodeError: {
        borderColor: theme.colors.state.danger.foreground,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    timelineNodeRunning: {
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    timelineNumber: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
    iconBox: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconBoxSelected: {
        borderColor: theme.colors.accent.blue,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 15,
        lineHeight: 19,
    },
    titleCompact: {
        fontSize: 13,
        lineHeight: 18,
    },
    subtitle: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    subtitleCompact: {
        fontSize: 12,
        lineHeight: 16,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    trailingOnboarding: {
        paddingTop: 2,
    },
    statusLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
    badge: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderRadius: 999,
    },
    badgeText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
    detailsToggle: {
        padding: 2,
    },
    detailsToggleHidden: {
        opacity: 0,
    },
    detailsToggleSlot: {
        width: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
    details: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    iconBoxBase: {
        width: 26,
        height: 26,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    iconBoxDone: {
        borderColor: theme.colors.state.success.foreground,
        backgroundColor: theme.colors.surface.selected,
    },
    iconBoxError: {
        borderColor: theme.colors.state.danger.foreground,
        backgroundColor: theme.colors.surface.selected,
    },
    iconBoxQueued: {
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    iconBoxRunning: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surface.base,
    },
    iconPlainBase: {
        width: 30,
        height: 30,
        borderWidth: 0,
        borderRadius: 0,
        backgroundColor: 'transparent',
    },
    iconPlainRunning: {
        width: 30,
        height: 30,
    },
    iconPlainCompactBase: {
        width: 24,
        height: 24,
    },
    iconPlainCompactRunning: {
        width: 24,
        height: 24,
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
    const styles = stylesheet;
    const [hovered, setHovered] = React.useState(false);
    const status = getRowStatus(props.item, props.phase, props.selected, props.execution);
    const statusLabel = props.phase === 'execute' ? getStatusLabel(status) : null;
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
                onPress={(event) => {
                    (event as { stopPropagation?: () => void })?.stopPropagation?.();
                    props.onToggleExpanded();
                }}
                style={({ pressed }) => ([
                    styles.detailsToggle,
                    shouldRevealDetailsToggle ? null : styles.detailsToggleHidden,
                    pressed ? { opacity: 0.7 } : null,
                ])}
            >
                <Icon
                    name={props.expanded ? 'caret-up' : 'caret-down'}
                    size={16}
                    color={theme.colors.text.secondary}
                />
            </Pressable>
        </View>
    ) : null;

    return (
        <View>
            <Pressable
                testID={props.testID}
                accessibilityRole={rowOnPress ? 'button' : undefined}
                disabled={!rowOnPress}
                onPress={rowOnPress}
                onHoverIn={Platform.OS === 'web' && detailsAvailable ? () => setHovered(true) : undefined}
                onHoverOut={Platform.OS === 'web' && detailsAvailable ? () => setHovered(false) : undefined}
                style={({ pressed }) => ([
                    styles.row,
                    usesOnboardingVariant ? styles.rowOnboarding : null,
                    usesCompactNestedRow ? styles.rowCompact : null,
                    props.selected ? styles.rowSelected : null,
                    hovered && !props.selected && rowOnPress ? styles.rowHovered : null,
                    pressed && rowOnPress ? { backgroundColor: theme.colors.surface.pressed } : null,
                    dimRow ? styles.rowDisabled : null,
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
                        <View
                            testID={statusSlotTestID}
                            style={[
                                usesOnboardingVariant ? styles.timelineNode : styles.iconBoxBase,
                                usesOnboardingVariant && status === 'done' ? styles.timelineNodeDone : null,
                                usesOnboardingVariant && status === 'error' ? styles.timelineNodeError : null,
                                usesOnboardingVariant && status === 'running' ? styles.timelineNodeRunning : null,
                                usesCompactNestedRow ? styles.timelineNodeCompact : null,
                                !usesOnboardingVariant && status === 'done' ? styles.iconBoxDone : null,
                                !usesOnboardingVariant && status === 'error' ? styles.iconBoxError : null,
                                !usesOnboardingVariant && status === 'queued' ? styles.iconBoxQueued : null,
                                !usesOnboardingVariant && status === 'running' ? styles.iconBoxRunning : null,
                                !usesOnboardingVariant && props.selected ? styles.iconBoxSelected : null,
                                usesOnboardingVariant && status === 'running' ? styles.iconPlainRunning : null,
                                usesCompactNestedRow ? styles.iconPlainCompactBase : null,
                                usesCompactNestedRow && status === 'running' ? styles.iconPlainCompactRunning : null,
                            ]}
                        >
                            {status === 'running' ? (
                                <ActivitySpinner
                                    size={usesCompactNestedRow ? 16 : (usesOnboardingVariant ? 18 : 16)}
                                    color={usesOnboardingVariant ? theme.colors.text.secondary : theme.colors.accent.blue}
                                />
                            ) : iconName ? (
                                usesOnboardingVariant && status !== 'done' && status !== 'error' ? (
                                    <Text style={styles.timelineNumber}>{timelineNodeIndex}</Text>
                                ) : (
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
                                )
                            ) : null}
                        </View>
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
                        <Text style={styles.statusLabel}>{statusLabel}</Text>
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
                    {detailsToggle}
                </View>
            </Pressable>

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
