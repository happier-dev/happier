import * as React from 'react';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { View, type GestureResponderEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { InboxWorkRow } from '../InboxWorkRow';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import {
    ItemGroupRowPositionProvider,
    useItemGroupRowPosition,
} from '@/components/ui/lists/ItemGroupRowPosition';
import { InboxSection } from '@/components/inbox/InboxSection';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { TactilePressable } from '@/components/ui/interactions/TactilePressable';
import { t } from '@/text';
import {
    useServerScopedMachine,
    useSessionListRenderableWithServerScope,
} from '@/sync/domains/state/storage';
import { useSessionListHomeObservations } from '@/sync/store/hooks';
import { useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import {
    actionOperationAddress,
    actionOperationAddressKey,
} from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useSessionAudienceContext } from '@/hooks/teams/useSessionAudienceContext';

import { openActionOperation } from './actionOperationPresentationRuntime';
import {
    classifyActionOperationSection,
    canRequestActionOperationStop,
    describeActionOperationStatusLabel,
    formatActionOperationAge,
    resolveActionOperationStatus,
    type ActionOperationSection,
} from './actionOperationPresentation';
import { requestAcceptedActionOperationStop, type ActionOperationStopResponse, type ActionOperationStopContext, type ActionOperationStopTarget } from './requestActionOperationStop';
import { useActionOperationStopControl } from './useActionOperationStopControl';
import { projectActionOperationSourceContext } from './actionOperationSourceContext';

const SECTION_ORDER: readonly ActionOperationSection[] = ['inProgress', 'needsAttention', 'recent'];

function translateSection(section: ActionOperationSection): string {
    switch (section) {
        case 'inProgress': return t('inbox.actionOperations.sections.inProgress');
        case 'needsAttention': return t('inbox.actionOperations.sections.needsAttention');
        case 'recent': return t('inbox.actionOperations.sections.recent');
    }
}

const ActionOperationRow = React.memo(function ActionOperationRow(props: Readonly<{
    operation: ActionOperationProjection;
    presentation?: 'activity' | 'inbox';
    audienceScopes: ReadonlyMap<string, ServerAccountScope>;
    onOpenOperation: (operation: ActionOperationProjection) => void;
    onCancelOperation?: (operation: ActionOperationProjection, context?: ActionOperationStopContext) => Promise<ActionOperationStopResponse | void> | void;
    onDismissOperation?: (operation: ActionOperationProjection) => void;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { snapshot, observation } = props.operation;
    const sessionId = snapshot.scope.sessionId ?? null;
    const serverId = props.operation.serverId;
    const session = useSessionListRenderableWithServerScope(serverId, serverId && sessionId ? sessionId : '');
    const machine = useServerScopedMachine(serverId, serverId ? snapshot.scope.machineId : '');
    // Row-local, like this row's Session and Machine reads, so a Home observation change repaints
    // only the rows bound to that Home rather than the whole ledger.
    const homeObservations = useSessionListHomeObservations();
    const status = resolveActionOperationStatus(snapshot, observation);
    const statusLabel = describeActionOperationStatusLabel(status.label);
    const sourceContext = projectActionOperationSourceContext({
        serverId,
        snapshot,
        session,
        machine,
        serverProfile: serverId ? getServerProfileById(serverId) : null,
        audienceScope: serverId ? props.audienceScopes.get(serverId) : null,
        homeObservation: serverId ? homeObservations[serverId] ?? null : null,
    });
    const sourceTitle = sourceContext.sessionTitle ?? sourceContext.machineTitle ?? snapshot.actionId;
    const determinateProgress = snapshot.progress?.kind === 'determinate'
        ? t('inbox.actionOperations.progress', {
            current: snapshot.progress.current,
            total: snapshot.progress.total,
        })
        : null;
    const inboxPresentation = props.presentation === 'inbox';
    const subtitleText = inboxPresentation
        ? joinHappierFacts(props.operation.followUpAttention ?? statusLabel, sourceTitle)
        : sourceTitle;
    const detailText = joinHappierFacts(...(inboxPresentation
        ? [determinateProgress, sourceContext.contextLine]
        : [
            props.operation.followUpAttention,
            formatActionOperationAge(snapshot),
            determinateProgress,
            sourceContext.contextLine,
        ]));
    const active = snapshot.state === 'accepted' || snapshot.state === 'running';
    const canDismiss = Boolean(props.onDismissOperation)
        && (inboxPresentation || (active && props.operation.isUnavailableProjection));
    const canStop = Boolean(serverId)
        && !inboxPresentation
        && !canDismiss
        && !props.operation.isUnavailableProjection
        && canRequestActionOperationStop(snapshot, observation);
    const requestStop = React.useCallback((_operation: ActionOperationStopTarget, context: ActionOperationStopContext) => props.onCancelOperation?.(props.operation, context), [props.onCancelOperation, props.operation]);
    const stopControl = useActionOperationStopControl(props.operation, requestStop);
    const stopPending = stopControl.pending;
    const stopFailed = stopControl.feedback === 'failed';
    const iconColor = props.operation.followUpAttention || status.tone === 'danger'
        ? theme.colors.status.error
        : status.tone === 'success'
            ? theme.colors.status.connected
            : theme.colors.text.secondary;
    const stop = React.useCallback((event?: GestureResponderEvent) => {
        event?.stopPropagation();
        if (!props.onCancelOperation || stopPending || stopControl.stopRequested) return;
        stopControl.requestStop();
    }, [props.onCancelOperation, stopControl.requestStop, stopControl.stopRequested, stopPending]);

    const dismiss = React.useCallback((event?: GestureResponderEvent) => {
        event?.stopPropagation();
        props.onDismissOperation?.(props.operation);
    }, [props.onDismissOperation, props.operation]);
    const dismissButton = canDismiss && props.onDismissOperation ? <TactilePressable
        testID={`action-operation-dismiss.${snapshot.operationId}`} accessibilityLabel={t('inbox.actionOperations.dismiss')}
        onPress={dismiss} glyph style={styles.stopButton}>
        <Icon name="x" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
    </TactilePressable> : undefined;
    const workStatus = resolveWorkStatusTone({ kind: 'action_operation', facts: { state: snapshot.state, observation,
        setupReview: snapshot.setupReview, word: props.operation.followUpAttention ?? statusLabel } });

    if (inboxPresentation) return <InboxWorkRow
        testID={`inbox.action-operation.${snapshot.operationId}`} title={snapshot.title}
        facts={[sourceTitle, determinateProgress, sourceContext.contextLine]}
        phase={workStatus.bucket === 'working' ? 'live' : workStatus.bucket === 'needs_you' ? 'attention' : 'finished'}
        status={workStatus}
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${snapshot.title}, ${props.operation.followUpAttention ?? statusLabel}, ${detailText}${sourceContext.accessibilityContext ? `, ${sourceContext.accessibilityContext}` : ''}`}
        mark={<Icon name={status.tone === 'success' ? 'check-circle' : status.tone === 'danger' ? 'warning-circle' : 'clock'} size={ICON_SIZE.md} color={iconColor} />}
        trailingAccessory={dismissButton}
        onPress={() => props.onOpenOperation(props.operation)}
    />;

    return (
        <Item
            testID={`inbox.action-operation.${snapshot.operationId}`}
            title={snapshot.title}
            subtitle={subtitleText}
            detail={detailText || undefined}
            accessibilityLabel={`${snapshot.title}, ${props.operation.followUpAttention ?? statusLabel}, ${detailText}${sourceContext.accessibilityContext ? `, ${sourceContext.accessibilityContext}` : ''}`}
            accessibilityLiveRegion="polite"
            density="compact"
            leftElement={active && observation === 'available'
                ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                : <Icon
                    name={status.tone === 'success' ? 'check-circle' : status.tone === 'danger' ? 'warning-circle' : 'clock'}
                    size={ICON_SIZE.md}
                    color={iconColor}
                  />}
            rightElement={canStop ? (
                <TactilePressable
                    testID={`action-operation-stop.${snapshot.operationId}`}
                    accessibilityLabel={t('inbox.actionOperations.cancel.stop')}
                    disabled={stopPending || stopControl.stopRequested}
                    onPress={stop}
                    glyph
                    containerStyle={stopPending ? styles.stopButtonPending : undefined}
                    style={styles.stopButton}
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
                </TactilePressable>
            ) : dismissButton}
            rightElementOutsidePressable={true}
            keepChevronWithRightElement={inboxPresentation && canDismiss}
            showDivider={props.showDivider}
            onPress={() => props.onOpenOperation(props.operation)}
        />
    );
});

/**
 * Headerless operation rows for a section whose hierarchy is owned by its host.
 * The row itself remains the one owner of source context, status, and controls.
 */
export const ActionOperationRows = React.memo(function ActionOperationRows(props: Readonly<{
    operations: readonly ActionOperationProjection[];
    presentation?: 'activity' | 'inbox';
    onOpenOperation: (operation: ActionOperationProjection) => void;
    onCancelOperation?: (operation: ActionOperationProjection, context?: ActionOperationStopContext) => Promise<ActionOperationStopResponse | void> | void;
    onDismissOperation?: (operation: ActionOperationProjection) => void;
    /** Supplied by ItemGroup when this row collection sits among sibling rows. */
    showDivider?: boolean;
}>) {
    useServerProfilesGeneration();
    const sessionAddresses = React.useMemo(() => props.operations.flatMap((operation) => {
        const sessionId = operation.snapshot.scope.sessionId;
        return operation.serverId && sessionId ? [{ serverId: operation.serverId, sessionId }] : [];
    }), [props.operations]);
    const audienceContext = useSessionAudienceContext(sessionAddresses);
    const parentRowPosition = useItemGroupRowPosition();

    return props.operations.map((operation, index) => {
        const isLast = index === props.operations.length - 1;
        return (
            <ItemGroupRowPositionProvider
                key={actionOperationAddressKey(actionOperationAddress(
                    operation.serverId,
                    operation.snapshot.operationId,
                ))}
                value={parentRowPosition ? {
                    isFirst: parentRowPosition.isFirst && index === 0,
                    isLast: parentRowPosition.isLast && isLast,
                } : null}
            >
                <ActionOperationRow
                    operation={operation}
                    presentation={props.presentation}
                    audienceScopes={audienceContext.scopes}
                    onOpenOperation={props.onOpenOperation}
                    onCancelOperation={props.onCancelOperation}
                    onDismissOperation={props.onDismissOperation}
                    showDivider={isLast ? props.showDivider : true}
                />
            </ItemGroupRowPositionProvider>
        );
    });
});

export const ActionOperationLedgerView = React.memo(function ActionOperationLedgerView(props: Readonly<{
    operations: readonly ActionOperationProjection[];
    preferredSessionAddress?: SessionAddress | null;
    onOpenOperation: (operation: ActionOperationProjection) => void;
    onCancelOperation?: (operation: ActionOperationProjection, context?: ActionOperationStopContext) => Promise<ActionOperationStopResponse | void> | void;
    onDismissOperation?: (operation: ActionOperationProjection) => void;
    onClearRecent?: () => void;
}>) {
    useServerProfilesGeneration();
    const sessionAddresses = React.useMemo(() => props.operations.flatMap((operation) => {
        const sessionId = operation.snapshot.scope.sessionId;
        return operation.serverId && sessionId ? [{ serverId: operation.serverId, sessionId }] : [];
    }), [props.operations]);
    const audienceContext = useSessionAudienceContext(sessionAddresses);
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
        const preferredSessionAddress = props.preferredSessionAddress ?? null;
        if (preferredSessionAddress) {
            for (const section of SECTION_ORDER) {
                grouped[section].sort((left, right) => {
                    const leftPreferred = areSessionAddressesEqual(
                        left.serverId && left.snapshot.scope.sessionId
                            ? { serverId: left.serverId, sessionId: left.snapshot.scope.sessionId }
                            : null,
                        preferredSessionAddress,
                    );
                    const rightPreferred = areSessionAddressesEqual(
                        right.serverId && right.snapshot.scope.sessionId
                            ? { serverId: right.serverId, sessionId: right.snapshot.scope.sessionId }
                            : null,
                        preferredSessionAddress,
                    );
                    return leftPreferred === rightPreferred ? 0 : leftPreferred ? -1 : 1;
                });
            }
        }
        return grouped;
    }, [props.operations, props.preferredSessionAddress]);

    if (props.operations.length === 0) return null;

    return (
        <View testID="inbox.action-operations" style={styles.container}>
            {SECTION_ORDER.map((section) => sections[section].length > 0 ? (
                <InboxSection
                    key={section}
                    testID={`inbox.section.operations.${section}`}
                    title={translateSection(section)}
                >
                    {sections[section].map((operation) => (
                        <ActionOperationRow
                            key={actionOperationAddressKey(actionOperationAddress(
                                operation.serverId,
                                operation.snapshot.operationId,
                            ))}
                            operation={operation}
                            audienceScopes={audienceContext.scopes}
                            onOpenOperation={props.onOpenOperation}
                            onCancelOperation={props.onCancelOperation}
                            onDismissOperation={props.onDismissOperation}
                        />
                    ))}
                    {section === 'recent' && props.onClearRecent ? (
                        <Item
                            testID="action-operations-clear-recent"
                            title={t('inbox.actionOperations.clearRecent')}
                            density="compact"
                            onPress={props.onClearRecent}
                        />
                    ) : null}
                </InboxSection>
            ) : null)}
        </View>
    );
});

export const ActionOperationLedger = React.memo(function ActionOperationLedger(props: Readonly<{
    preferredSessionAddress?: SessionAddress | null;
}> = {}) {
    const operations = useAllActionOperations();
    const stopOperation = React.useCallback(async (operation: ActionOperationProjection, context?: ActionOperationStopContext) => {
        return await requestAcceptedActionOperationStop(operation, context);
    }, []);
    return (
        <ActionOperationLedgerView
            operations={operations}
            preferredSessionAddress={props.preferredSessionAddress}
            onOpenOperation={openActionOperation}
            onCancelOperation={stopOperation}
            onDismissOperation={(operation) => actionOperationStore.dismissUnavailable(
                actionOperationAddress(operation.serverId, operation.snapshot.operationId),
            )}
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
    stopButtonPending: {
        opacity: 0.45,
    },
}));
