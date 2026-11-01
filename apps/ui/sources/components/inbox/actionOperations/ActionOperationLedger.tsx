import * as React from 'react';
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import {
    ItemGroupRowPositionProvider,
    useItemGroupRowPosition,
} from '@/components/ui/lists/ItemGroupRowPosition';
import { Text } from '@/components/ui/text/Text';
import { ListSection } from '@/components/ui/lists/ListSection';
import { useNowMs } from '@/hooks/time/useNowMs';
import { t } from '@/text';
import { isActionOperationCancellationRequested } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationReentry } from '@/sync/domains/actionOperations/actionOperationReentry';

import {
    buildActionOperationLedgerSections,
    resolveActionOperationPresentation,
    type ActionOperationObservationPresentation,
    type ActionOperationPresentationStatus,
} from './actionOperationPresentation';

const LEDGER_CLOCK_INTERVAL_MS = 30_000;

export type ActionOperationLedgerProps = Readonly<{
    operations: readonly ActionOperationSnapshotV1[];
    observationForOperation?: (operation: ActionOperationSnapshotV1) => ActionOperationObservationPresentation;
    contextForOperation?: (operation: ActionOperationSnapshotV1) => string | null;
    onOpenOperation: (operationId: string) => void;
    showEmptyState?: boolean;
    nowMs?: number;
    preferredSessionId?: string | null;
    onCancelOperation?: (operationId: string) => Promise<void> | void;
    canDismissOperation?: (operation: ActionOperationSnapshotV1) => boolean;
    onDismissOperation?: (operationId: string) => void;
    onClearRecent?: () => void;
}>;

export type ActionOperationRowsProps = Readonly<{
    operations: readonly ActionOperationSnapshotV1[];
    observationForOperation?: (operation: ActionOperationSnapshotV1) => ActionOperationObservationPresentation;
    contextForOperation?: (operation: ActionOperationSnapshotV1) => string | null;
    onOpenOperation: (operationId: string) => void;
    nowMs?: number;
    onCancelOperation?: (operationId: string) => Promise<void> | void;
    canDismissOperation?: (operation: ActionOperationSnapshotV1) => boolean;
    onDismissOperation?: (operationId: string) => void;
    /** Inbox moves status into the subtitle and omits Activity's status glyph. */
    presentationMode?: 'activity' | 'inbox';
    /** Supplied by ItemGroup when this row collection sits among sibling rows. */
    showDivider?: boolean;
}>;

function statusLabel(status: ActionOperationPresentationStatus): string {
    switch (status) {
        case 'accepted': return t('inbox.actionOperations.status.accepted');
        case 'running': return t('inbox.actionOperations.status.running');
        case 'succeeded': return t('inbox.actionOperations.status.succeeded');
        case 'failed': return t('inbox.actionOperations.status.failed');
        case 'cancelled': return t('inbox.actionOperations.status.cancelled');
        case 'reconnecting': return t('inbox.actionOperations.status.reconnecting');
        case 'status_unavailable': return t('inbox.actionOperations.status.unavailable');
        case 'setup_needs_attention': return t('inbox.actionOperations.status.setupNeedsAttention');
    }
}

const ActionOperationStatusGlyph = React.memo(function ActionOperationStatusGlyph(props: Readonly<{
    status: ActionOperationPresentationStatus;
}>) {
    const { theme } = useUnistyles();
    const size = ICON_SIZE.sm;
    if (props.status === 'accepted' || props.status === 'running' || props.status === 'reconnecting') {
        return (
            <ActivitySpinner
                testID="action-operation-status-spinner"
                size={iconMatchedSpinnerSize(size)}
                color={theme.colors.text.secondary}
                animationEnabled={props.status !== 'reconnecting'}
            />
        );
    }
    if (props.status === 'succeeded') {
        return <Icon name="check-circle" size={size} color={theme.colors.state.success.foreground} />;
    }
    if (props.status === 'failed') {
        return <Icon name="warning-circle" size={size} color={theme.colors.state.danger.foreground} />;
    }
    if (props.status === 'cancelled') {
        return <Icon name="x-circle" size={size} color={theme.colors.text.secondary} />;
    }
    return <Icon name="warning" size={size} color={theme.colors.text.secondary} />;
});

const ActionOperationRow = React.memo(function ActionOperationRow(props: Readonly<{
    operation: ActionOperationSnapshotV1;
    observation: ActionOperationObservationPresentation;
    context: string | null;
    nowMs: number;
    onOpenOperation: (operationId: string) => void;
    onCancelOperation?: (operationId: string) => Promise<void> | void;
    canDismissOperation?: (operation: ActionOperationSnapshotV1) => boolean;
    onDismissOperation?: (operationId: string) => void;
    presentationMode?: 'activity' | 'inbox';
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const presentation = resolveActionOperationPresentation(props.operation, props.observation, props.nowMs);
    const status = statusLabel(presentation.status);
    const progress = [presentation.progressLabel, presentation.progressValue].filter(Boolean).join('  ');
    const subtitle = props.presentationMode === 'inbox'
        ? [[status, props.context].filter(Boolean).join(' · '), progress].filter(Boolean).join('\n')
        : [props.context, progress].filter(Boolean).join('\n');
    const canDismiss = props.canDismissOperation?.(props.operation) === true;
    const canStop = !canDismiss && !presentation.terminal && props.operation.cancellation === 'supported';
    const [stopRequestPending, setStopPending] = React.useState(false);
    const stopPending = stopRequestPending || isActionOperationCancellationRequested(props.operation);
    const [stopFailed, setStopFailed] = React.useState(false);

    const stop = React.useCallback((event?: GestureResponderEvent) => {
        event?.stopPropagation();
        if (!props.onCancelOperation || stopPending) return;
        setStopPending(true);
        setStopFailed(false);
        Promise.resolve(props.onCancelOperation(props.operation.operationId))
            .catch(() => setStopFailed(true))
            .finally(() => setStopPending(false));
    }, [props.onCancelOperation, props.operation.operationId, stopPending]);

    return (
        <Item
            testID={`action-operation-row-${props.operation.operationId}`}
            title={props.operation.title}
            subtitle={subtitle}
            subtitleLines={3}
            density="compact"
            detail={presentation.timeValue}
            icon={<Icon name={presentation.iconName} size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
            rightElement={(
                <View style={styles.rowActions}>
                    {canStop ? (
                        <Pressable
                            testID={`action-operation-stop-${props.operation.operationId}`}
                            accessibilityRole="button"
                            accessibilityLabel={t('inbox.actionOperations.stop')}
                            disabled={stopPending}
                            hitSlop={8}
                            onPress={stop}
                            style={({ pressed }) => [
                                styles.stopButton,
                                pressed ? styles.stopButtonPressed : null,
                                stopPending ? styles.stopButtonPending : null,
                            ]}
                        >
                            {stopPending ? (
                                <ActivitySpinner size={iconMatchedSpinnerSize(ICON_SIZE.sm)} color={theme.colors.text.secondary} />
                            ) : (
                                <Icon
                                    name={stopFailed ? 'warning-circle' : 'stop'}
                                    size={ICON_SIZE.sm}
                                    color={stopFailed ? theme.colors.state.danger.foreground : theme.colors.text.secondary}
                                />
                            )}
                        </Pressable>
                    ) : null}
                    {canDismiss && props.onDismissOperation ? (
                        <Pressable
                            testID={`action-operation-dismiss-${props.operation.operationId}`}
                            accessibilityRole="button"
                            accessibilityLabel={t('inbox.actionOperations.dismiss')}
                            hitSlop={8}
                            onPress={(event) => {
                                event?.stopPropagation();
                                props.onDismissOperation?.(props.operation.operationId);
                            }}
                            style={({ pressed }) => [
                                styles.stopButton,
                                pressed ? styles.stopButtonPressed : null,
                            ]}
                        >
                            <Icon name="x" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                        </Pressable>
                    ) : null}
                    {props.presentationMode === 'activity' ? (
                        <View style={styles.statusAccessory} accessibilityLabel={status}>
                            <ActionOperationStatusGlyph status={presentation.status} />
                        </View>
                    ) : null}
                </View>
            )}
            rightElementOutsidePressable={true}
            keepChevronWithRightElement={true}
            showDivider={props.showDivider}
            accessibilityLabel={`${props.operation.title}, ${status}`}
            accessibilityHint={t('inbox.actionOperations.openHint')}
            accessibilityState={{ busy: !presentation.terminal }}
            onPress={() => props.onOpenOperation(props.operation.operationId)}
        />
    );
});

/**
 * Canonical operation-row renderer shared by Activity's self-grouped ledger and
 * Inbox's cross-domain sections. Keeping the row here prevents status, recovery,
 * cancellation, dismissal, and accessibility behavior from drifting by surface.
 */
export const ActionOperationRows = React.memo(function ActionOperationRows(props: ActionOperationRowsProps) {
    const runtimeNowMs = useNowMs(LEDGER_CLOCK_INTERVAL_MS);
    const nowMs = props.nowMs ?? runtimeNowMs;
    const parentRowPosition = useItemGroupRowPosition();
    return (
        <>
            {props.operations.map((operation, index) => {
                const isLast = index === props.operations.length - 1;
                return (
                    <ItemGroupRowPositionProvider
                        key={operation.operationId}
                        value={parentRowPosition ? {
                            isFirst: parentRowPosition.isFirst && index === 0,
                            isLast: parentRowPosition.isLast && isLast,
                        } : null}
                    >
                        <ActionOperationRow
                            operation={operation}
                            observation={props.observationForOperation?.(operation) ?? 'available'}
                            context={props.contextForOperation?.(operation) ?? null}
                            nowMs={nowMs}
                            onOpenOperation={props.onOpenOperation}
                            onCancelOperation={props.onCancelOperation}
                            canDismissOperation={props.canDismissOperation}
                            onDismissOperation={props.onDismissOperation}
                            presentationMode={props.presentationMode ?? 'activity'}
                            showDivider={isLast ? props.showDivider : true}
                        />
                    </ItemGroupRowPositionProvider>
                );
            })}
        </>
    );
});

export const ActionOperationLedger = React.memo(function ActionOperationLedger(props: ActionOperationLedgerProps) {
    const reentryRevision = React.useSyncExternalStore(
        actionOperationReentry.subscribe,
        actionOperationReentry.getRevision,
        actionOperationReentry.getRevision,
    );
    const runtimeNowMs = useNowMs(LEDGER_CLOCK_INTERVAL_MS);
    const nowMs = props.nowMs ?? runtimeNowMs;
    const sections = React.useMemo(
        () => buildActionOperationLedgerSections(props.operations, {
            preferredSessionId: props.preferredSessionId,
            observationForOperation: props.observationForOperation,
        }),
        [props.observationForOperation, props.operations, props.preferredSessionId, reentryRevision],
    );

    const renderRows = React.useCallback((operations: readonly ActionOperationSnapshotV1[]) => (
        <ActionOperationRows
            operations={operations}
            observationForOperation={props.observationForOperation}
            contextForOperation={props.contextForOperation}
            nowMs={nowMs}
            onOpenOperation={props.onOpenOperation}
            onCancelOperation={props.onCancelOperation}
            canDismissOperation={props.canDismissOperation}
            onDismissOperation={props.onDismissOperation}
        />
    ), [nowMs, props.canDismissOperation, props.contextForOperation, props.observationForOperation, props.onCancelOperation, props.onDismissOperation, props.onOpenOperation]);

    if (
        sections.inProgress.length === 0
        && sections.needsAttention.length === 0
        && sections.recent.length === 0
    ) {
        if (props.showEmptyState === false) return null;
        return (
            <View testID="action-operation-ledger-empty" style={styles.empty}>
                <Icon name="tray" size={ICON_SIZE.lg} />
                <Text style={styles.emptyText}>{t('inbox.actionOperations.empty')}</Text>
            </View>
        );
    }

    return (
        <View testID="action-operation-ledger">
            {sections.inProgress.length > 0 ? (
                <ListSection namespace="inbox" id="operations-in-progress" title={t('inbox.actionOperations.sections.inProgress')}>
                    {renderRows(sections.inProgress)}
                </ListSection>
            ) : null}
            {sections.needsAttention.length > 0 ? (
                <ListSection namespace="inbox" id="operations-needs-attention" title={t('inbox.actionOperations.sections.needsAttention')}>
                    {renderRows(sections.needsAttention)}
                </ListSection>
            ) : null}
            {sections.recent.length > 0 ? (
                <ListSection
                    namespace="inbox"
                    id="operations-recent"
                    title={t('inbox.actionOperations.sections.recent')}
                    headerAction={props.onClearRecent ? (
                        <Pressable
                            testID="action-operation-clear-recent"
                            accessibilityRole="button"
                            onPress={props.onClearRecent}
                            hitSlop={8}
                            style={({ pressed }) => [
                                styles.clearRecentButton,
                                pressed ? styles.clearRecentButtonPressed : null,
                            ]}
                        >
                            <Text style={styles.clearRecentText}>{t('inbox.actionOperations.clearRecent')}</Text>
                        </Pressable>
                    ) : null}
                >
                    {renderRows(sections.recent)}
                </ListSection>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    rowActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
    },
    statusAccessory: {
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    clearRecentButton: {
        minHeight: 44,
        justifyContent: 'center',
        paddingLeft: 12,
    },
    clearRecentButtonPressed: {
        opacity: 0.62,
    },
    clearRecentText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    stopButton: {
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
    stopButtonPressed: {
        opacity: 0.7,
        transform: [{ scale: 0.94 }],
    },
    stopButtonPending: {
        opacity: 0.45,
    },
    empty: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingVertical: 36,
        gap: 12,
    },
    emptyText: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
        lineHeight: 20,
    },
}));
