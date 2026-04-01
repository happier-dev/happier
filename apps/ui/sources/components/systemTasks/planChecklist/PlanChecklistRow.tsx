import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
} from './types';

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

function getExecutionStatusIcon(status: PlanChecklistItemStatus, selected: boolean): React.ComponentProps<typeof Ionicons>['name'] | null {
    if (status === 'running') {
        return null;
    }
    if (status === 'done') {
        return 'checkmark-circle';
    }
    if (status === 'error') {
        return 'close-circle';
    }
    if (status === 'queued') {
        return 'ellipse-outline';
    }
    if (status === 'idle') {
        return 'ellipse-outline';
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

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        width: '100%',
        paddingHorizontal: 16,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        backgroundColor: theme.colors.surface,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    rowDisabled: {
        opacity: 0.55,
    },
    rowHovered: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowContent: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    leading: {
        width: 26,
        height: 26,
        alignItems: 'center',
        justifyContent: 'center',
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
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 19,
    },
    subtitle: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    statusLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
    },
    badge: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: theme.colors.surfacePressedOverlay,
        borderRadius: 999,
    },
    badgeText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
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
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    iconBoxBase: {
        width: 26,
        height: 26,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    iconBoxDone: {
        borderColor: theme.colors.success,
        backgroundColor: theme.colors.surfaceSelected,
    },
    iconBoxError: {
        borderColor: theme.colors.warningCritical,
        backgroundColor: theme.colors.surfaceSelected,
    },
    iconBoxQueued: {
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    iconBoxRunning: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surface,
    },
}));

export type PlanChecklistRowProps = Readonly<{
    testID?: string;
    item: PlanChecklistItem;
    phase: PlanChecklistPhase;
    selected: boolean;
    execution?: PlanChecklistExecutionState;
    expanded: boolean;
    onToggle: () => void;
    onToggleExpanded: () => void;
    onCopyDiagnostics?: () => void | Promise<void>;
}>;

export const PlanChecklistRow = React.memo(function PlanChecklistRow(props: PlanChecklistRowProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [hovered, setHovered] = React.useState(false);
    const status = getRowStatus(props.item, props.phase, props.selected, props.execution);
    const statusLabel = props.phase === 'execute' ? getStatusLabel(status) : null;
    const itemRenderDetails: (() => React.ReactNode) | undefined = React.useMemo(() => {
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
    }, [props.item.details, props.item.renderDetails]);
    const detailsAvailable = Boolean(itemRenderDetails || (props.execution?.logs?.length ?? 0) > 0 || props.onCopyDiagnostics);
    const shouldRevealDetailsToggle = detailsAvailable && (Platform.OS !== 'web' || hovered || props.expanded);
    const iconName = props.phase === 'select'
        ? (status === 'done' ? 'checkmark-circle' : (props.selected ? 'checkmark-circle-outline' : 'ellipse-outline'))
        : getExecutionStatusIcon(status, props.selected);
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
                <Ionicons
                    name={props.expanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={theme.colors.textSecondary}
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
                    props.selected ? styles.rowSelected : null,
                    hovered && !props.selected && rowOnPress ? styles.rowHovered : null,
                    pressed && rowOnPress ? { backgroundColor: theme.colors.surfacePressed } : null,
                    dimRow ? styles.rowDisabled : null,
                ])}
            >
                <View style={styles.rowContent}>
                    <View style={styles.leading}>
                        <View
                            testID={statusSlotTestID}
                            style={[
                                styles.iconBoxBase,
                                status === 'done' ? styles.iconBoxDone : null,
                                status === 'error' ? styles.iconBoxError : null,
                                status === 'queued' ? styles.iconBoxQueued : null,
                                status === 'running' ? styles.iconBoxRunning : null,
                                props.selected ? styles.iconBoxSelected : null,
                            ]}
                        >
                            {status === 'running' ? (
                                <ActivityIndicator size={16} color={theme.colors.accent.blue} />
                            ) : iconName ? (
                                <Ionicons
                                    name={iconName}
                                    size={16}
                                    color={
                                        status === 'done'
                                            ? theme.colors.success
                                            : status === 'error'
                                                ? theme.colors.warningCritical
                                                : props.selected
                                                    ? theme.colors.accent.blue
                                                    : theme.colors.textTertiary
                                    }
                                />
                            ) : null}
                        </View>
                    </View>

                    <View style={styles.titleColumn}>
                        <Text style={styles.title} numberOfLines={1}>
                            {props.item.title}
                        </Text>
                        {props.item.subtitle ? (
                            <Text style={styles.subtitle} numberOfLines={2}>
                                {props.item.subtitle}
                            </Text>
                        ) : null}
                    </View>
                </View>

                <View style={styles.trailing}>
                    {statusLabel ? (
                        <Text style={styles.statusLabel}>{statusLabel}</Text>
                    ) : null}
                    {props.item.badge ? (
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
                        error={props.execution?.error}
                        logs={props.execution?.logs}
                        onCopyDiagnostics={props.onCopyDiagnostics}
                    />
                </View>
            ) : null}
        </View>
    );
});
