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
import { actionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import {
    useServerScopedMachine,
    useSessionListRenderableWithServerScope,
} from '@/sync/domains/state/storage';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { acknowledgeActionOperationPresented } from '@/sync/domains/actionOperations/acknowledgeActionOperationPresented';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useSessionAudienceContext } from '@/hooks/teams/useSessionAudienceContext';
import { useSessionListHomeObservations } from '@/sync/store/hooks';

import {
    describeActionOperationStatusLabel,
    formatActionOperationAge,
    readActionOperationDestinationSessionId,
    readActionOperationDestinationServerId,
    readActionOperationPluginIdentity,
    resolveActionOperationStatus,
} from './actionOperationPresentation';
import {
    projectActionOperationDetail,
    readActionOperationOutputAttachment,
    type ActionOperationDetailField,
    type ActionOperationDetailProjection,
} from './actionOperationDetailPresentation';
import { resumeActionOperationHandoff } from './resumeActionOperationHandoff';
import { ActionOperationDetailControls } from './ActionOperationDetailControls';
import { ProjectCommandOutputPane } from './ProjectCommandOutputPane';
import { projectActionOperationSourceContext } from './actionOperationSourceContext';

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

function describeProjectCommandPurpose(purpose: 'setup' | 'teardown' | 'script' | 'exec'): string {
    switch (purpose) {
        case 'setup': return t('projects.scripts.output.purpose.setup');
        case 'teardown': return t('projects.scripts.output.purpose.teardown');
        case 'exec': return t('projects.scripts.output.purpose.exec');
        case 'script': return t('projects.scripts.output.purpose.script');
    }
}

export type ActionOperationDetailModalProps = CustomModalInjectedProps & Readonly<{
    serverId: string | null;
    operationId: string;
}>;

export const ActionOperationDetailModal = React.memo(function ActionOperationDetailModal(
    props: ActionOperationDetailModalProps,
) {
    const { theme } = useUnistyles();
    const router = useRouter();
    useServerProfilesGeneration();
    const operation = useActionOperation(actionOperationAddress(props.serverId, props.operationId));
    const sessionId = operation?.snapshot.scope.sessionId ?? null;
    const exactServerId = operation?.serverId ?? null;
    const session = useSessionListRenderableWithServerScope(
        exactServerId,
        exactServerId && sessionId ? sessionId : '',
    );
    const machine = useServerScopedMachine(
        exactServerId,
        exactServerId ? operation?.snapshot.scope.machineId ?? '' : '',
    );
    const sessionAddresses = React.useMemo(() => exactServerId && sessionId
        ? [{ serverId: exactServerId, sessionId }]
        : [], [exactServerId, sessionId]);
    const audienceContext = useSessionAudienceContext(sessionAddresses);
    const homeObservations = useSessionListHomeObservations();
    const projectCommandRef = operation ? readActionOperationOutputAttachment(operation.snapshot) : null;
    const projectCommandMachine = useServerScopedMachine(projectCommandRef?.serverId ?? null, projectCommandRef?.machineId ?? '');
    const projectCommandMachineName = projectCommandMachine ? getMachineDisplayName(projectCommandMachine) ?? null : null;
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
            testID: 'action-operation-detail',
            titleTestID: 'action-operation-detail-heading',
            dimensions: { size: 'dialog' },
        });
        return () => props.setChrome?.(null);
    }, [operation?.snapshot.title, props.setChrome]);

    React.useEffect(() => {
        if (operation && isActionOperationTerminal(operation.snapshot.state)) {
            acknowledgeActionOperationPresented(operation.snapshot, operation.serverId);
        }
    }, [operation]);

    if (!operation) {
        return (
            <View style={styles.body}>
                <Text style={styles.message}>{t('inbox.actionOperations.unavailableDescription')}</Text>
                <RoundButton title={t('common.done')} onPress={props.onClose} testID="action-operation-done" />
            </View>
        );
    }

    const { snapshot, observation } = operation;
    const sourceContext = projectActionOperationSourceContext({
        serverId: operation.serverId,
        snapshot,
        session,
        machine,
        serverProfile: operation.serverId ? getServerProfileById(operation.serverId) : null,
        audienceScope: operation.serverId ? audienceContext.scopes.get(operation.serverId) : null,
        homeObservation: operation.serverId ? homeObservations[operation.serverId] ?? null : null,
    });
    const status = resolveActionOperationStatus(snapshot, observation);
    const statusLabel = describeActionOperationStatusLabel(status.label);
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

    const requestHandoffResume = () => {
        if (detail.nextAction?.kind !== 'resume_handoff' || resumePending) return;
        setResumePending(true);
        setResumeFeedback(null);
        void resumeActionOperationHandoff({
            serverId: operation.serverId,
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
                        {describeActionOperationStatusLabel({ kind: 'host', value: snapshot.state })}
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
                    subtitle={[
                        sourceContext.machineTitle ?? snapshot.scope.machineId,
                        sessionId ? null : sourceContext.contextLine,
                    ].filter(Boolean).join(' · ')}
                />
                {sessionId ? (
                    <Item
                        mode="info"
                        title={t('inbox.actionOperations.session')}
                        subtitle={[
                            sourceContext.sessionTitle ?? sessionId,
                            sourceContext.contextLine,
                        ].filter(Boolean).join(' · ')}
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

            {detail.projectCommand || detail.machineEnvironment ? (
                <ItemGroup title={t('projects.scripts.output.title')}>
                    <Item
                        testID="action-operation-project-command.target"
                        mode="info"
                        title={t('projects.scripts.output.ranOn')}
                        subtitle={detail.projectCommand ? `${projectCommandMachineName ?? detail.projectCommand.machineId} · ${detail.projectCommand.cwd}`
                            : projectCommandMachineName ?? detail.machineEnvironment!.machineId}
                    />
                    <View style={styles.output}>
                        <ProjectCommandOutputPane operation={operation} title={detail.projectCommand ? describeProjectCommandPurpose(detail.projectCommand.purpose)
                            : t('managedMachines.creation.setup')} height={280} />
                    </View>
                </ItemGroup>
            ) : null}

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

            <ActionOperationDetailControls
                operation={operation}
                terminal={terminal}
                canCancel={Boolean(operation.serverId) && detail.canCancel}
                onClose={props.onClose}
                leading={(
                    <>
                        {operation.serverId && detail.nextAction?.kind === 'resume_handoff' ? (
                            <RoundButton
                                title={t('inbox.actionOperations.recovery.resumeAction')}
                                testID="action-operation-resume-handoff"
                                loading={resumePending}
                                disabled={resumePending || resumeFeedback === t('inbox.actionOperations.recovery.resumeRequested')}
                                onPress={requestHandoffResume}
                            />
                        ) : null}
                        {openSessionId && readActionOperationDestinationServerId(snapshot, operation.serverId) ? (
                            <RoundButton
                                title={t('runs.openSession')}
                                testID="action-operation-open-session"
                                onPress={() => {
                                    router.push(createActivitySurfaceSessionRoute(
                                        openSessionId,
                                        readActionOperationDestinationServerId(snapshot, operation.serverId),
                                    ));
                                    props.onClose();
                                }}
                            />
                        ) : null}
                    </>
                )}
            />
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
    output: {
        paddingHorizontal: 12,
        paddingBottom: 12,
    },
    cancelFeedback: {
        color: theme.colors.text.primary,
    },
}));
