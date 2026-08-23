import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { CustomModalInjectedProps } from '@/modal';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { useMachine, useSession } from '@/sync/domains/state/storage';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

import {
    formatActionOperationAge,
    readActionOperationDestinationSessionId,
    readActionOperationPluginIdentity,
    resolveActionOperationStatus,
} from './actionOperationPresentation';
import {
    projectActionOperationDetail,
    type ActionOperationDetailField,
    type ActionOperationDetailProjection,
} from './actionOperationDetailPresentation';
import { resumeActionOperationHandoff } from './resumeActionOperationHandoff';
import { requestActionOperationStop } from './requestActionOperationStop';

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

function translateDetailField(field: ActionOperationDetailField): string {
    switch (field.id) {
        case 'strategy': return t('inbox.actionOperations.detailFields.strategy');
        case 'result': return t('inbox.actionOperations.detailFields.result');
        case 'session': return t('inbox.actionOperations.detailFields.createdSession');
        case 'phase': return t('inbox.actionOperations.detailFields.phase');
        case 'reference': return t('inbox.actionOperations.reference');
    }
}

function translateDetailFieldValue(
    field: ActionOperationDetailField,
    kind: ActionOperationDetailProjection['kind'],
): string {
    if (field.id === 'strategy') {
        switch (field.value) {
            case 'native': return t('inbox.actionOperations.forkStrategies.native');
            case 'provider_native': return t('inbox.actionOperations.forkStrategies.providerNative');
            case 'acp_fork_latest': return t('inbox.actionOperations.forkStrategies.acpNative');
            case 'replay': return t('inbox.actionOperations.forkStrategies.replay');
            case 'auto': return t('inbox.actionOperations.forkStrategies.auto');
        }
    }
    if (field.id === 'result' && kind === 'spawn') {
        if (field.value === 'created') return t('inbox.actionOperations.spawnResults.created');
        if (field.value === 'rejoined') return t('inbox.actionOperations.spawnResults.rejoined');
    }
    if (field.id === 'result' && kind === 'handoff' && field.value === 'completed') {
        return t('inbox.actionOperations.handoffResults.completed');
    }
    return field.value;
}

function translateRecovery(detail: ActionOperationDetailProjection): string | null {
    switch (detail.recovery?.kind) {
        case 'fork_lineage': return t('inbox.actionOperations.recovery.forkLineage');
        case 'spawn_custody': return t('inbox.actionOperations.recovery.spawnCustody');
        case 'handoff': return t('inbox.actionOperations.recovery.handoff', {
            actions: detail.recovery.actions.join(', '),
        });
        case undefined: return null;
    }
}

export type ActionOperationDetailModalProps = CustomModalInjectedProps & Readonly<{
    operationId: string;
}>;

export const ActionOperationDetailModal = React.memo(function ActionOperationDetailModal(
    props: ActionOperationDetailModalProps,
) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const operation = useActionOperation(props.operationId);
    const machine = useMachine(operation?.snapshot.scope.machineId ?? '');
    const session = useSession(operation?.snapshot.scope.sessionId ?? '');
    const [cancelPending, setCancelPending] = React.useState(false);
    const [cancelFeedback, setCancelFeedback] = React.useState<
        'requested' | 'unsupported' | 'already_settled' | 'not_found' | 'failed' | null
    >(null);
    const [resumePending, setResumePending] = React.useState(false);
    const [resumeFeedback, setResumeFeedback] = React.useState<string | null>(null);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        props.setChrome?.({
            kind: 'card',
            title: operation?.snapshot.title ?? t('inbox.actionOperations.unavailableTitle'),
            subtitle: operation ? operation.snapshot.actionId : undefined,
            testID: 'action-operation-detail',
            titleTestID: 'action-operation-detail-heading',
            dimensions: { size: 'dialog' },
        });
        return () => props.setChrome?.(null);
    }, [operation?.snapshot.actionId, operation?.snapshot.title, props.setChrome]);

    if (!operation) {
        return (
            <View style={styles.body}>
                <Text style={styles.message}>{t('inbox.actionOperations.unavailableDescription')}</Text>
                <RoundButton title={t('common.done')} onPress={props.onClose} testID="action-operation-done" />
            </View>
        );
    }

    const { snapshot, observation } = operation;
    const status = resolveActionOperationStatus(snapshot, observation);
    const statusLabel = status.label.kind === 'producer'
        ? status.label.value
        : translateHostStatus(status.label.value);
    const destinationSessionId = readActionOperationDestinationSessionId(snapshot);
    const terminal = isActionOperationTerminal(snapshot.state);
    const pluginIdentity = readActionOperationPluginIdentity(snapshot.actionId);
    const detail = projectActionOperationDetail(snapshot, observation);
    const recoveryDescription = translateRecovery(detail);
    const showStatusDetail = status.label.kind === 'producer'
        || status.label.value === 'reconnecting'
        || status.label.value === 'unavailable';
    const openSessionId = detail.nextAction?.kind === 'open_session'
        ? detail.nextAction.sessionId
        : destinationSessionId;

    const requestCancellation = () => {
        if (!detail.canCancel || cancelPending) return;
        setCancelPending(true);
        setCancelFeedback(null);
        void requestActionOperationStop(snapshot).then((result) => {
            if (!mountedRef.current) return;
            setCancelFeedback(result.kind);
        }).catch(() => {
            if (!mountedRef.current) return;
            setCancelFeedback('failed');
        }).finally(() => {
            if (mountedRef.current) setCancelPending(false);
        });
    };
    const requestHandoffResume = () => {
        if (detail.nextAction?.kind !== 'resume_handoff' || resumePending) return;
        setResumePending(true);
        setResumeFeedback(null);
        void resumeActionOperationHandoff({
            handoffId: detail.nextAction.handoffId,
            sessionId: detail.nextAction.sessionId,
            targetMachineId: detail.nextAction.targetMachineId,
        }).then((result) => {
            if (!mountedRef.current) return;
            setResumeFeedback(result.kind === 'requested'
                ? t('inbox.actionOperations.recovery.resumeRequested')
                : result.kind === 'not_available'
                    ? t('inbox.actionOperations.recovery.resumeNoLongerAvailable')
                    : result.message);
        }).catch(() => {
            if (mountedRef.current) {
                setResumeFeedback(t('inbox.actionOperations.recovery.resumeFailed'));
            }
        }).finally(() => {
            if (mountedRef.current) setResumePending(false);
        });
    };

    return (
        <View style={styles.body}>
            <View accessibilityLiveRegion="polite" style={styles.hero}>
                {!terminal && observation === 'available' ? (
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                ) : (
                    <Icon
                        name={snapshot.state === 'succeeded' ? 'check-circle' : snapshot.state === 'failed' ? 'warning-circle' : 'clock'}
                        size={18}
                        color={status.tone === 'danger' ? theme.colors.status.error : theme.colors.text.secondary}
                    />
                )}
                <View style={styles.heroCopy}>
                    <Text style={[styles.status, status.tone === 'danger' ? styles.danger : undefined]}>
                        {translateHostStatus(snapshot.state)}
                    </Text>
                    {showStatusDetail ? <Text style={styles.progress}>{statusLabel}</Text> : null}
                    {snapshot.progress?.kind === 'determinate' ? (
                        <Text style={styles.numeric}>
                            {t('inbox.actionOperations.progress', {
                                current: snapshot.progress.current,
                                total: snapshot.progress.total,
                            })}
                        </Text>
                    ) : null}
                </View>
            </View>

            <ItemGroup title={t('inbox.actionOperations.details')}>
                {pluginIdentity ? (
                    <Item
                        mode="info"
                        title={t('inbox.actionOperations.pluginAction')}
                        subtitle={pluginIdentity}
                    />
                ) : null}
                <Item
                    mode="info"
                    title={t('inbox.actionOperations.machine')}
                    subtitle={machine ? getMachineDisplayName(machine) : snapshot.scope.machineId}
                />
                {snapshot.scope.sessionId ? (
                    <Item
                        mode="info"
                        title={t('inbox.actionOperations.session')}
                        subtitle={session ? getSessionName(session) : snapshot.scope.sessionId}
                    />
                ) : null}
                <Item
                    mode="info"
                    title={terminal ? t('inbox.actionOperations.settled') : t('inbox.actionOperations.elapsed')}
                    subtitle={formatActionOperationAge(snapshot)}
                />
                {detail.fields.map((field) => (
                    <Item
                        key={field.id}
                        testID={`action-operation-field.${field.id}`}
                        mode="info"
                        title={translateDetailField(field)}
                        subtitle={translateDetailFieldValue(field, detail.kind)}
                    />
                ))}
            </ItemGroup>

            {detail.warning ? (
                <View
                    testID="action-operation-warning"
                    accessibilityLiveRegion="polite"
                    role="status"
                    style={styles.warning}
                >
                    <Icon name="warning" size={18} color={theme.colors.state.warning.foreground} />
                    <View style={styles.noticeCopy}>
                        <Text style={styles.warningTitle}>{t('inbox.actionOperations.warning.cleanupTitle')}</Text>
                        <Text style={styles.warningBody}>{t('inbox.actionOperations.warning.cleanupDescription')}</Text>
                        <Text style={styles.warningDetail}>{detail.warning.message}</Text>
                    </View>
                </View>
            ) : null}

            {operation.followUpAttention ? (
                <View
                    testID="action-operation-follow-up-attention"
                    accessibilityLiveRegion="polite"
                    role="status"
                    style={styles.warning}
                >
                    <Icon name="warning" size={18} color={theme.colors.state.warning.foreground} />
                    <View style={styles.noticeCopy}>
                        <Text style={styles.warningTitle}>{operation.followUpAttention}</Text>
                    </View>
                </View>
            ) : null}

            {recoveryDescription ? (
                <View
                    testID="action-operation-recovery"
                    accessibilityLiveRegion="polite"
                    role="status"
                    style={styles.recovery}
                >
                    <Icon name="info" size={18} color={theme.colors.text.secondary} />
                    <View style={styles.noticeCopy}>
                        <Text style={styles.recoveryTitle}>{t('inbox.actionOperations.recovery.title')}</Text>
                        <Text style={styles.recoveryBody}>{recoveryDescription}</Text>
                    </View>
                </View>
            ) : null}

            {resumeFeedback ? (
                <Text
                    testID="action-operation-resume-feedback"
                    accessibilityLiveRegion="polite"
                    role="status"
                    style={styles.cancelFeedback}
                >
                    {resumeFeedback}
                </Text>
            ) : null}

            {detail.resultSummary.length > 0 ? (
                <ItemGroup title={t('inbox.actionOperations.resultSummary')}>
                    {detail.resultSummary.map((row) => (
                        <Item
                            key={row.label}
                            testID={`action-operation-result.${row.label}`}
                            mode="info"
                            title={row.label}
                            subtitle={row.value}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {detail.errorSummary.length > 0 ? (
                <ItemGroup title={t('common.error')}>
                    {detail.errorSummary.map((row) => (
                        <Item
                            key={row.label}
                            testID={`action-operation-error.${row.label}`}
                            mode="info"
                            title={row.label}
                            subtitle={row.value}
                            destructive={true}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {detail.canCancel ? (
                <View style={styles.cancelSection}>
                    <Text style={styles.cancelHint}>{t('inbox.actionOperations.cancel.hint')}</Text>
                    {cancelFeedback ? (
                        <Text
                            testID="action-operation-cancel-feedback"
                            accessibilityLiveRegion="polite"
                            role="status"
                            style={styles.cancelFeedback}
                        >
                            {cancelFeedback === 'requested'
                                ? t('inbox.actionOperations.cancel.requested')
                                : cancelFeedback === 'already_settled'
                                    ? t('inbox.actionOperations.cancel.alreadySettled')
                                    : cancelFeedback === 'unsupported'
                                        ? t('inbox.actionOperations.cancel.unsupported')
                                        : cancelFeedback === 'not_found'
                                            ? t('inbox.actionOperations.cancel.notFound')
                                            : t('inbox.actionOperations.cancel.failed')}
                        </Text>
                    ) : null}
                </View>
            ) : null}

            <View style={styles.actions}>
                {detail.nextAction?.kind === 'resume_handoff' ? (
                    <RoundButton
                        title={t('inbox.actionOperations.recovery.resumeAction')}
                        testID="action-operation-resume-handoff"
                        loading={resumePending}
                        disabled={resumePending || resumeFeedback === t('inbox.actionOperations.recovery.resumeRequested')}
                        onPress={requestHandoffResume}
                    />
                ) : null}
                {openSessionId ? (
                    <RoundButton
                        title={t('runs.openSession')}
                        testID="action-operation-open-session"
                        onPress={() => {
                            router.push(createActivitySurfaceSessionRoute(openSessionId));
                            props.onClose();
                        }}
                    />
                ) : null}
                {detail.canCancel ? (
                    <RoundButton
                        display="inverted"
                        title={cancelPending ? t('runs.stop.stoppingLabel') : t('inbox.actionOperations.cancel.stop')}
                        testID="action-operation-cancel"
                        loading={cancelPending}
                        disabled={cancelPending || cancelFeedback === 'requested'}
                        onPress={requestCancellation}
                    />
                ) : null}
                <RoundButton
                    display="inverted"
                    title={terminal ? t('common.done') : t('common.collapse')}
                    testID={terminal ? 'action-operation-done' : 'action-operation-collapse'}
                    onPress={props.onClose}
                />
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 20,
        gap: 14,
    },
    hero: {
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: theme.colors.surface.elevated,
    },
    heroCopy: {
        flex: 1,
        minWidth: 0,
        gap: 3,
    },
    status: {
        color: theme.colors.text.primary,
        fontWeight: '700',
    },
    danger: {
        color: theme.colors.status.error,
    },
    progress: {
        color: theme.colors.text.secondary,
    },
    numeric: {
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    message: {
        color: theme.colors.text.secondary,
    },
    warning: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.state.warning.border,
        backgroundColor: theme.colors.state.warning.background,
    },
    recovery: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        padding: 14,
        borderRadius: 14,
        backgroundColor: theme.colors.surface.elevated,
    },
    noticeCopy: {
        flex: 1,
        gap: 3,
    },
    warningTitle: {
        color: theme.colors.state.warning.foreground,
        fontWeight: '700',
    },
    warningBody: {
        color: theme.colors.text.primary,
    },
    warningDetail: {
        color: theme.colors.text.secondary,
    },
    recoveryTitle: {
        color: theme.colors.text.primary,
        fontWeight: '700',
    },
    recoveryBody: {
        color: theme.colors.text.secondary,
    },
    cancelSection: {
        gap: 4,
    },
    cancelHint: {
        color: theme.colors.text.secondary,
    },
    cancelFeedback: {
        color: theme.colors.text.primary,
    },
    actions: {
        minHeight: 44,
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
    },
}));
