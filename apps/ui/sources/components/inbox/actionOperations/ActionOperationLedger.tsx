import * as React from 'react';
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { useMachine, useSessionListPreferredMetadata } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

import { openActionOperation } from './actionOperationPresentationRuntime';
import {
    classifyActionOperationSection,
    formatActionOperationAge,
    resolveActionOperationStatus,
    type ActionOperationSection,
} from './actionOperationPresentation';
import { requestAcceptedActionOperationStop } from './requestActionOperationStop';

const SECTION_ORDER: readonly ActionOperationSection[] = ['inProgress', 'needsAttention', 'recent'];

function translateHostStatus(value: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'reconnecting' | 'unavailable'): string {
    switch (value) {
        case 'accepted': return t('inbox.actionOperations.status.accepted');
        case 'running': return t('inbox.actionOperations.status.running');
        case 'succeeded': return t('inbox.actionOperations.status.succeeded');
        case 'failed': return t('inbox.actionOperations.status.failed');
        case 'cancelled': return t('inbox.actionOperations.status.cancelled');
        case 'reconnecting': return t('inbox.actionOperations.observation.reconnecting');
        case 'unavailable': return t('inbox.actionOperations.observation.unavailable');
    }
}

function translateSection(section: ActionOperationSection): string {
    switch (section) {
        case 'inProgress': return t('inbox.actionOperations.sections.inProgress');
        case 'needsAttention': return t('inbox.actionOperations.sections.needsAttention');
        case 'recent': return t('inbox.actionOperations.sections.recent');
    }
}

const ActionOperationRow = React.memo(function ActionOperationRow(props: Readonly<{
    operation: ActionOperationProjection;
    onOpenOperation: (operationId: string) => void;
    onCancelOperation?: (operationId: string) => Promise<void> | void;
    onDismissOperation?: (operationId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const { snapshot, observation } = props.operation;
    const sessionId = snapshot.scope.sessionId ?? null;
    const sessionMetadata = useSessionListPreferredMetadata(sessionId);
    const machine = useMachine(sessionId ? '' : snapshot.scope.machineId);
    const status = resolveActionOperationStatus(snapshot, observation);
    const statusLabel = status.label.kind === 'producer'
        ? status.label.value
        : translateHostStatus(status.label.value);
    const context = sessionId
        ? sessionMetadata
            ? getSessionName({ id: sessionId, metadata: sessionMetadata })
            : ''
        : getMachineDisplayName(machine) ?? '';
    const determinateProgress = snapshot.progress?.kind === 'determinate'
        ? t('inbox.actionOperations.progress', {
            current: snapshot.progress.current,
            total: snapshot.progress.total,
        })
        : null;
    const detailText = [
        props.operation.followUpAttention,
        formatActionOperationAge(snapshot),
        determinateProgress,
    ].filter(Boolean).join(' · ');
    const active = snapshot.state === 'accepted' || snapshot.state === 'running';
    const canDismiss = active && props.operation.isUnavailableProjection;
    const canStop = !canDismiss && observation === 'available' && active && snapshot.cancellation === 'supported';
    const [stopPending, setStopPending] = React.useState(false);
    const [stopFailed, setStopFailed] = React.useState(false);
    const iconColor = props.operation.followUpAttention || status.tone === 'danger'
        ? theme.colors.status.error
        : status.tone === 'success'
            ? theme.colors.status.connected
            : theme.colors.text.secondary;
    const stop = React.useCallback((event?: GestureResponderEvent) => {
        event?.stopPropagation();
        if (!props.onCancelOperation || stopPending) return;
        setStopPending(true);
        setStopFailed(false);
        Promise.resolve(props.onCancelOperation(snapshot.operationId))
            .catch(() => setStopFailed(true))
            .finally(() => setStopPending(false));
    }, [props.onCancelOperation, snapshot.operationId, stopPending]);

    return (
        <Item
            testID={`inbox.action-operation.${snapshot.operationId}`}
            title={snapshot.title}
            subtitle={context || snapshot.actionId}
            detail={detailText}
            accessibilityLabel={`${snapshot.title}, ${props.operation.followUpAttention ?? statusLabel}, ${detailText}${context ? `, ${context}` : ''}`}
            accessibilityLiveRegion="polite"
            leftElement={active && observation === 'available'
                ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                : <Icon
                    name={status.tone === 'success' ? 'check-circle' : status.tone === 'danger' ? 'warning-circle' : 'clock'}
                    size={ICON_SIZE.md}
                    color={iconColor}
                  />}
            rightElement={canStop ? (
                <Pressable
                    testID={`action-operation-stop.${snapshot.operationId}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('inbox.actionOperations.cancel.stop')}
                    disabled={stopPending}
                    onPress={stop}
                    style={({ pressed }) => [
                        styles.stopButton,
                        pressed ? styles.stopButtonPressed : null,
                        stopPending ? styles.stopButtonPending : null,
                    ]}
                >
                    {stopPending ? (
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    ) : (
                        <Icon
                            name={stopFailed ? 'warning-circle' : 'stop'}
                            size={ICON_SIZE.sm}
                            color={stopFailed ? theme.colors.status.error : theme.colors.text.secondary}
                        />
                    )}
                </Pressable>
            ) : canDismiss && props.onDismissOperation ? (
                <Pressable
                    testID={`action-operation-dismiss.${snapshot.operationId}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('inbox.actionOperations.dismiss')}
                    onPress={(event) => {
                        event?.stopPropagation();
                        props.onDismissOperation?.(snapshot.operationId);
                    }}
                    style={({ pressed }) => [
                        styles.stopButton,
                        pressed ? styles.stopButtonPressed : null,
                    ]}
                >
                    <Icon name="x" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                </Pressable>
            ) : undefined}
            onPress={() => props.onOpenOperation(snapshot.operationId)}
        />
    );
});

export const ActionOperationLedgerView = React.memo(function ActionOperationLedgerView(props: Readonly<{
    operations: readonly ActionOperationProjection[];
    preferredSessionId?: string | null;
    onOpenOperation: (operationId: string) => void;
    onCancelOperation?: (operationId: string) => Promise<void> | void;
    onDismissOperation?: (operationId: string) => void;
    onClearRecent?: () => void;
}>) {
    const sections = React.useMemo(() => {
        const grouped: Record<ActionOperationSection, ActionOperationProjection[]> = {
            inProgress: [],
            needsAttention: [],
            recent: [],
        };
        for (const operation of props.operations) {
            grouped[operation.followUpAttention
                ? 'needsAttention'
                : classifyActionOperationSection(operation.snapshot, operation.observation)].push(operation);
        }
        const preferredSessionId = props.preferredSessionId ?? null;
        if (preferredSessionId) {
            for (const section of SECTION_ORDER) {
                grouped[section].sort((left, right) => {
                    const leftPreferred = left.snapshot.scope.sessionId === preferredSessionId;
                    const rightPreferred = right.snapshot.scope.sessionId === preferredSessionId;
                    return leftPreferred === rightPreferred ? 0 : leftPreferred ? -1 : 1;
                });
            }
        }
        return grouped;
    }, [props.operations, props.preferredSessionId]);

    if (props.operations.length === 0) return null;

    return (
        <View testID="inbox.action-operations" style={styles.container}>
            {SECTION_ORDER.map((section) => sections[section].length > 0 ? (
                <ItemGroup
                    key={section}
                    title={translateSection(section)}
                    selectableItemCountOverride={sections[section].length}
                >
                    {sections[section].map((operation) => (
                        <ActionOperationRow
                            key={operation.snapshot.operationId}
                            operation={operation}
                            onOpenOperation={props.onOpenOperation}
                            onCancelOperation={props.onCancelOperation}
                            onDismissOperation={props.onDismissOperation}
                        />
                    ))}
                    {section === 'recent' && props.onClearRecent ? (
                        <Item
                            testID="action-operations-clear-recent"
                            title={t('inbox.actionOperations.clearRecent')}
                            onPress={props.onClearRecent}
                        />
                    ) : null}
                </ItemGroup>
            ) : null)}
        </View>
    );
});

export const ActionOperationLedger = React.memo(function ActionOperationLedger(props: Readonly<{
    preferredSessionId?: string | null;
}> = {}) {
    const operations = useAllActionOperations();
    const stopOperation = React.useCallback(async (operationId: string) => {
        const operation = operations.find((candidate) => candidate.snapshot.operationId === operationId);
        if (operation) await requestAcceptedActionOperationStop(operation.snapshot);
    }, [operations]);
    return (
        <ActionOperationLedgerView
            operations={operations}
            preferredSessionId={props.preferredSessionId}
            onOpenOperation={(operationId) => {
                const operation = operations.find((candidate) => candidate.snapshot.operationId === operationId);
                if (operation) openActionOperation(operation.snapshot);
            }}
            onCancelOperation={stopOperation}
            onDismissOperation={actionOperationStore.dismissUnavailable}
            onClearRecent={actionOperationStore.dismissRecentSucceeded}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
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
}));
