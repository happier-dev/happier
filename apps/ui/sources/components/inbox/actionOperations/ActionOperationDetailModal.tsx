import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { isDeploymentBackupEvidenceActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { isMachineSetupOperationActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';
import { FailureInvestigationActions } from '@/components/inbox/detail/FailureInvestigationActions';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';

import type { CustomModalInjectedProps } from '@/modal';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Icon } from '@/components/ui/icons/Icon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ProjectSetupConsentReviewCard } from '@/components/projects/projectSetup/ProjectSetupSessionReview';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { actionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import {
  useServerScopedMachine,
  useSessionListRenderableWithServerScope,
} from '@/sync/domains/state/storage';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { createWorkflowInvocationRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { acknowledgeActionOperationPresented } from '@/sync/domains/actionOperations/acknowledgeActionOperationPresented';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useSessionAudienceContext } from '@/hooks/teams/useSessionAudienceContext';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useSessionListHomeObservations } from '@/sync/store/hooks';
import { useManagedMachineName } from '@/components/approvals/approvalReferenceReading';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';

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
import { OpenDeploymentBackupsButton } from './OpenDeploymentBackupsButton';
import {
  AgentIsolationRecovery,
  AgentIsolationReview,
} from './AgentIsolationReview';
import {
  isAgentIsolationOutcomeUnknown,
  useAgentIsolationRecovery,
} from './useAgentIsolationRecovery';
import { ProjectCommandOutputPane } from './ProjectCommandOutputPane';
import { MachineSetupStepsChecklist } from './MachineSetupStepsChecklist';
import { MachineFirewallRecovery } from '@/components/machines/security/network/MachineFirewallRecovery';
import { projectActionOperationSourceContext } from './actionOperationSourceContext';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { ActionOperationSudoQuestion } from './ActionOperationSudoQuestion';
import { ActionOperationSshQuestion } from './ActionOperationSshQuestion';
import { readActionOperationSudoPrompt } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { readManagedInstallationPromptSnapshot } from '@/sync/domains/actionOperations/managedMachineOperation';

function translateDetailField(field: ActionOperationDetailField): string {
  switch (field.id) {
    case 'strategy':
      return t('inbox.actionOperations.detailFields.strategy');
    case 'result':
      return t('inbox.actionOperations.detailFields.result');
    case 'session':
      return t('inbox.actionOperations.detailFields.createdSession');
    case 'phase':
      return t('inbox.actionOperations.detailFields.phase');
    case 'reference':
      return t('inbox.actionOperations.reference');
  }
}

function translateDetailFieldValue(
  field: ActionOperationDetailField,
  kind: ActionOperationDetailProjection['kind'],
): string {
  if (field.id === 'strategy') {
    switch (field.value) {
      case 'native':
        return t('inbox.actionOperations.forkStrategies.native');
      case 'provider_native':
        return t('inbox.actionOperations.forkStrategies.providerNative');
      case 'acp_fork_latest':
        return t('inbox.actionOperations.forkStrategies.acpNative');
      case 'replay':
        return t('inbox.actionOperations.forkStrategies.replay');
      case 'auto':
        return t('inbox.actionOperations.forkStrategies.auto');
    }
  }
  if (field.id === 'result' && kind === 'spawn') {
    if (field.value === 'created')
      return t('inbox.actionOperations.spawnResults.created');
    if (field.value === 'rejoined')
      return t('inbox.actionOperations.spawnResults.rejoined');
  }
  if (
    field.id === 'result' &&
    kind === 'handoff' &&
    field.value === 'completed'
  ) {
    return t('inbox.actionOperations.handoffResults.completed');
  }
  return field.value;
}

function translateRecovery(
  detail: ActionOperationDetailProjection,
): string | null {
  switch (detail.recovery?.kind) {
    case 'fork_lineage':
      return t('inbox.actionOperations.recovery.forkLineage');
    case 'spawn_custody':
      return t('inbox.actionOperations.recovery.spawnCustody');
    case 'handoff':
      return t('inbox.actionOperations.recovery.handoff', {
        actions: detail.recovery.actions.join(', '),
      });
    case undefined:
      return null;
  }
}

function describeProjectCommandPurpose(
  purpose: 'setup' | 'teardown' | 'script' | 'exec',
): string {
  switch (purpose) {
    case 'setup':
      return t('projects.scripts.output.purpose.setup');
    case 'teardown':
      return t('projects.scripts.output.purpose.teardown');
    case 'exec':
      return t('projects.scripts.output.purpose.exec');
    case 'script':
      return t('projects.scripts.output.purpose.script');
  }
}

export type ActionOperationDetailModalProps = CustomModalInjectedProps &
  Readonly<{
    serverId: string | null;
    operationId: string;
  }>;

export const ActionOperationDetailModal = React.memo(
  function ActionOperationDetailModal(props: ActionOperationDetailModalProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    useServerProfilesGeneration();
    const operation = useActionOperation(
      actionOperationAddress(props.serverId, props.operationId),
    );
    const isRecordingVisible = useSessionRecordingVisibility();
    const isolationCheck = useAgentIsolationRecovery(operation);
    const sessionId = operation?.snapshot.scope.sessionId ?? null;
    const exactServerId = operation?.serverId ?? null;
    const { binding: setupReviewBinding } = useServerCredentialAccountScopeBinding(
      operation?.snapshot.setupReview ? exactServerId : null,
    );
    const setupReviewScope = setupReviewBinding?.isCurrent()
      && setupReviewBinding.accountId === operation?.snapshot.scope.accountId ? setupReviewBinding.scope : null;
    const session = useSessionListRenderableWithServerScope(
      exactServerId,
      exactServerId && sessionId ? sessionId : '',
    );
    const projectCommandRef = operation
      ? readActionOperationOutputAttachment(operation.snapshot)
      : null;
    const machine = useServerScopedMachine(
      projectCommandRef?.serverId ?? exactServerId,
      projectCommandRef?.machineId ??
        (exactServerId ? (operation?.snapshot.scope.machineId ?? '') : ''),
    );
    const sessionAddresses = React.useMemo(
      () =>
        exactServerId && sessionId
          ? [{ serverId: exactServerId, sessionId }]
          : [],
      [exactServerId, sessionId],
    );
    const audienceContext = useSessionAudienceContext(sessionAddresses);
    const homeObservations = useSessionListHomeObservations();
    const projectCommandMachineName =
      projectCommandRef && machine
        ? (getMachineDisplayName(machine) ?? null)
        : null;
    // A managed power operation runs on its controller but concerns the managed guest, which the Machine row names.
    const managedMachineName = useManagedMachineName(
      exactServerId,
      operation?.snapshot.domainRef?.kind === 'managedMachine'
        ? operation.snapshot.domainRef.id
        : null,
    );
    const [resumePending, setResumePending] = React.useState(false);
    const [resumeFeedback, setResumeFeedback] = React.useState<string | null>(
      null,
    );
    const resumeControllerRef = React.useRef<AbortController | null>(null);

    React.useEffect(() => {
      setResumePending(false);
      setResumeFeedback(null);
      return () => {
        resumeControllerRef.current?.abort();
      };
    }, [props.operationId, props.serverId]);

    React.useEffect(() => {
      props.setChrome?.({
        kind: 'card',
        title:
          operation?.snapshot.title ??
          t('inbox.actionOperations.unavailableTitle'),
        testID: 'action-operation-detail',
        titleTestID: 'action-operation-detail-heading',
        dimensions: { size: 'dialog' },
      });
      return () => props.setChrome?.(null);
    }, [operation?.snapshot.title, props.setChrome]);

    const previousOperation = React.useRef(operation);
    React.useEffect(() => {
      const previous = previousOperation.current;
      previousOperation.current = operation;
      if (operation && previous && previous.serverId === operation.serverId
        && previous.snapshot.operationId === operation.snapshot.operationId
        && !isActionOperationTerminal(previous.snapshot.state)
        && isActionOperationTerminal(operation.snapshot.state)) {
        acknowledgeActionOperationPresented(operation.snapshot, operation.serverId);
      }
    }, [operation]);

    if (!operation) {
      return (
        <View style={styles.body}>
          <Text style={styles.message}>
            {t('inbox.actionOperations.unavailableDescription')}
          </Text>
          <RoundButton
            title={t('common.done')}
            onPress={props.onClose}
            testID="action-operation-done"
          />
        </View>
      );
    }

    const { snapshot, observation } = operation;
    const sourceContext = projectActionOperationSourceContext({
      isRecordingVisible,
      serverId: operation.serverId,
      snapshot,
      session,
      machine,
      managedMachineName,
      serverProfile: operation.serverId
        ? getServerProfileById(operation.serverId)
        : null,
      audience: operation.serverId && sessionId
        ? audienceContext.presentationsBySessionKey.get(sessionAddressKey({ serverId: operation.serverId, sessionId }))
        : null,
      homeObservation: operation.serverId
        ? (homeObservations[operation.serverId] ?? null)
        : null,
    });
    const status = resolveActionOperationStatus(snapshot, observation);
    const statusLabel = describeActionOperationStatusLabel(status.label);
    const destinationSessionId =
      readActionOperationDestinationSessionId(snapshot);
    const terminal = isActionOperationTerminal(snapshot.state);
    const sudoPrompt = readActionOperationSudoPrompt(snapshot);
    const managedPrompt = readManagedInstallationPromptSnapshot(snapshot);
    const isolationUnknown = isAgentIsolationOutcomeUnknown(operation);
    // The receipt only states what happened, as one quiet line; the CHECK's row beneath is the one status
    // (checking, can't check yet, still applying, nothing left, or what to apply again).
    const isolationReceipt = isolationUnknown
      ? { quiet: true, text: t('inbox.actionOperations.isolationRecovery.receiptChecked') }
      : null;
    const failedAddress = snapshot.state === 'failed' && operation.serverId ? {
      serverId: operation.serverId, machineId: snapshot.scope.machineId, operationId: snapshot.operationId,
    } : null;
    const setupRetry = failedAddress ? snapshot.error?.setupRetry : undefined;
    const investigationSubject: TriageFailureSubjectV1 | null = !failedAddress ? null
      : isDeploymentBackupEvidenceActionIdV1(snapshot.actionId) ? { kind: 'backupRun', operation: failedAddress }
      : snapshot.domainRef?.kind === 'managedMachine' || isMachineSetupOperationActionIdV1(snapshot.actionId)
        ? { kind: 'managedMachineOperation', operation: failedAddress } : null;
    const pluginIdentity = readActionOperationPluginIdentity(snapshot.actionId);
    const detail = projectActionOperationDetail(snapshot, observation);
    const recoveryDescription = translateRecovery(detail);
    const showStatusDetail =
      status.label.kind === 'producer' ||
      status.label.value === 'reconnecting' ||
      status.label.value === 'unavailable';
    const openSessionId =
      detail.nextAction?.kind === 'open_session'
        ? detail.nextAction.sessionId
        : destinationSessionId;

    const requestHandoffResume = () => {
      if (detail.nextAction?.kind !== 'resume_handoff' || resumePending) return;
      setResumePending(true);
      setResumeFeedback(null);
      const controller = new AbortController();
      resumeControllerRef.current?.abort();
      resumeControllerRef.current = controller;
      const isCurrentRequest = () =>
        !controller.signal.aborted &&
        resumeControllerRef.current === controller;
      void resumeActionOperationHandoff({
        serverId: operation.serverId,
        handoffId: detail.nextAction.handoffId,
        sessionId: detail.nextAction.sessionId,
        targetMachineId: detail.nextAction.targetMachineId,
        signal: controller.signal,
      })
        .then((result) => {
          if (!isCurrentRequest()) return;
          setResumeFeedback(
            result.kind === 'requested'
              ? t('inbox.actionOperations.recovery.resumeRequested')
              : result.kind === 'not_available'
                ? t('inbox.actionOperations.recovery.resumeNoLongerAvailable')
                : result.message,
          );
        })
        .catch(() => {
          if (isCurrentRequest()) {
            setResumeFeedback(
              t('inbox.actionOperations.recovery.resumeFailed'),
            );
          }
        })
        .finally(() => {
          if (isCurrentRequest()) setResumePending(false);
        });
    };

    return (
      <View style={styles.body}>
        <View
          accessibilityLiveRegion="polite"
          style={[
            styles.hero,
            isolationReceipt?.quiet ? styles.heroQuiet : undefined,
          ]}
        >
          {!terminal &&
          observation === 'available' &&
          status.label.kind === 'host' &&
          status.label.value !== 'outcome_uncertain' &&
          status.label.value !== 'needs_review' ? (
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
          ) : (
            <Icon
              name={
                snapshot.state === 'succeeded'
                  ? 'check-circle'
                  : snapshot.state === 'failed'
                    ? 'warning-circle'
                    : 'clock'
              }
              size={18}
              color={
                status.tone === 'danger'
                  ? theme.colors.status.error
                  : theme.colors.text.secondary
              }
            />
          )}
          <View style={styles.heroCopy}>
            <Text
              testID={
                isolationReceipt
                  ? 'action-operation-isolation-receipt'
                  : undefined
              }
              style={[
                styles.status,
                status.tone === 'danger' ? styles.danger : undefined,
                isolationReceipt?.quiet ? styles.statusQuiet : undefined,
              ]}
            >
              {isolationReceipt
                ? isolationReceipt.text
                : describeActionOperationStatusLabel(
                    status.label.kind === 'host' &&
                      (status.label.value === 'outcome_uncertain' ||
                        status.label.value === 'needs_review')
                      ? status.label
                      : { kind: 'host', value: snapshot.state },
                  )}
            </Text>
            {showStatusDetail ? (
              <Text style={styles.progress}>{statusLabel}</Text>
            ) : null}
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

        {isolationUnknown ? (
          <AgentIsolationRecovery
            operation={operation}
            check={isolationCheck}
          />
        ) : null}

        {/* Keyed by the Machine's question: a new question never inherits a draft, error or receipt. */}
        {sudoPrompt ? (
          <ActionOperationSudoQuestion key={sudoPrompt.id} operation={operation} />
        ) : null}
        {snapshot.domainRef?.kind === 'systemTask' && snapshot.domainRef.prompt ? (
          <ActionOperationSshQuestion key={snapshot.domainRef.id} operation={operation} />
        ) : null}
        {managedPrompt ? (
          <ItemGroup>
            <Item testID="action-operation-managed-question" mode="info" title={managedPrompt.message}
              titleLines={0} showChevron={false} />
          </ItemGroup>
        ) : null}

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
            subtitle={joinHappierFacts(
              sourceContext.machineTitle ??
                projectCommandRef?.machineId ??
                snapshot.scope.machineId,
              sessionId ? null : sourceContext.contextLine,
            )}
          />
          {sessionId ? (
            <Item
              mode="info"
              title={t('inbox.actionOperations.session')}
              subtitle={joinHappierFacts(
                sourceContext.sessionTitle ?? sessionId,
                sourceContext.contextLine,
              )}
            />
          ) : null}
          <Item
            mode="info"
            title={
              terminal
                ? t('inbox.actionOperations.settled')
                : t('inbox.actionOperations.elapsed')
            }
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

        {snapshot.setupReview && setupReviewScope ? (
          <ProjectSetupConsentReviewCard
            operation={operation}
            scope={setupReviewScope}
            decided={null}
            canApprovePermissions
            onDecided={props.onClose}
          />
        ) : null}

        {detail.agentIsolationReview ? (
          <AgentIsolationReview
            operation={operation}
            detail={detail.agentIsolationReview}
          />
        ) : null}

        {detail.machineSetup ? <MachineSetupStepsChecklist operation={operation} attachment={detail.machineSetup} /> : null}
        {detail.projectCommand?.steps?.length ? (
          <MachineSetupStepsChecklist operation={operation} attachment={detail.projectCommand} stepOutput
            title={describeProjectCommandPurpose(detail.projectCommand.purpose)} />
        ) : null}
        {detail.machineFirewallRecovery ? <MachineFirewallRecovery recovery={detail.machineFirewallRecovery} /> : null}

        {/* Setup without attached output would only restate the status and Machine shown above. */}
        {detail.projectCommand || detail.machineSetup?.terminalId ? (
          <ItemGroup title={t('projects.scripts.output.title')}>
            <Item
              testID="action-operation-project-command.target"
              mode="info"
              title={t('projects.scripts.output.ranOn')}
              subtitle={
                detail.projectCommand
                  ? joinHappierFacts(
                      projectCommandMachineName ??
                        detail.projectCommand.machineId,
                      detail.projectCommand.cwd,
                    )
                  : (projectCommandMachineName ??
                    detail.machineSetup!.machineId)
              }
            />
            <View style={styles.output}>
              <ProjectCommandOutputPane
                operation={operation}
                ownerStatesExit
                title={
                  detail.projectCommand
                    ? describeProjectCommandPurpose(
                        detail.projectCommand.purpose,
                      )
                    : t('managedMachines.creation.setup')
                }
                height={280}
              />
            </View>
          </ItemGroup>
        ) : null}

        {/* Attention and recovery notices are the page's one tinted notice owner, never a local tile. */}
        {detail.warning ? (
          <AttentionBanner
            testID="action-operation-warning"
            tone="warning"
            announce="status"
            title={t('inbox.actionOperations.warning.cleanupTitle')}
            description={t('inbox.actionOperations.warning.cleanupDescription')}
            details={[detail.warning.message]}
          />
        ) : null}

        {operation.followUpAttention ? (
          <AttentionBanner
            testID="action-operation-follow-up-attention"
            tone="warning"
            announce="status"
            title={operation.followUpAttention}
          />
        ) : null}

        {recoveryDescription ? (
          <AttentionBanner
            testID="action-operation-recovery"
            tone="neutral"
            announce="status"
            iconName="info"
            title={t('inbox.actionOperations.recovery.title')}
            description={recoveryDescription}
          />
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

        {detail.resultSummary.length > 0 || detail.resultTechnicalLines.length > 0 ? (
          <ItemGroup title={t('inbox.actionOperations.resultSummary')}>
            {detail.resultSummary.map((row) => (
              <Item
                key={row.label}
                testID={`action-operation-result.${row.label}`}
                mode="info"
                title={row.label}
                subtitle={row.value}
                subtitleLines={0}
              />
            ))}
            {detail.resultTechnicalLines.length > 0 ? (
              <TechnicalDetailsDisclosure
                testID="action-operation-result-technical-details"
                title={t('approvals.technicalDetails')}
                lines={detail.resultTechnicalLines}
              />
            ) : null}
          </ItemGroup>
        ) : null}

        {detail.failure ? (
          <ItemGroup title={t('common.error')}>
            <Item
              testID="action-operation-failure"
              mode="info"
              title={detail.failure.reason}
              titleLines={0}
            />
            {detail.failure.technicalLines.length > 0 ? (
              <TechnicalDetailsDisclosure
                testID="action-operation-technical-details"
                title={t('approvals.technicalDetails')}
                lines={detail.failure.technicalLines}
              />
            ) : null}
          </ItemGroup>
        ) : null}

        {investigationSubject && operation.serverId ? <SectionContentRow>
          <FailureInvestigationActions subject={investigationSubject} serverId={operation.serverId}
            controllerMachineId={snapshot.scope.machineId} compact={false} emphasis={setupRetry ? 'secondary' : undefined}
            testID="action-operation-investigate" />
        </SectionContentRow> : null}

        <ActionOperationDetailControls
          operation={operation}
          terminal={terminal}
          canCancel={Boolean(operation.serverId) && detail.canCancel && !setupReviewScope}
          onClose={props.onClose}
          leading={
            <>
              {setupRetry ? (
                <RoundButton
                  title={t('managedMachines.creation.retrySetup')}
                  testID="action-operation-retry-setup"
                  onPress={() => {
                    router.push(createWorkflowInvocationRoute(setupRetry.runId, setupRetry.invocationId, operation.serverId) as never);
                    props.onClose();
                  }}
                />
              ) : null}
              {detail.nextAction?.kind === 'open_deployment_backups' ? (
                <OpenDeploymentBackupsButton
                  serverId={detail.nextAction.serverId}
                  environmentId={detail.nextAction.environmentId}
                  onOpened={props.onClose}
                />
              ) : null}
              {operation.serverId &&
              detail.nextAction?.kind === 'resume_handoff' ? (
                <RoundButton
                  title={t('inbox.actionOperations.recovery.resumeAction')}
                  testID="action-operation-resume-handoff"
                  loading={resumePending}
                  disabled={
                    resumePending ||
                    resumeFeedback ===
                      t('inbox.actionOperations.recovery.resumeRequested')
                  }
                  onPress={requestHandoffResume}
                />
              ) : null}
              {openSessionId &&
              readActionOperationDestinationServerId(
                snapshot,
                operation.serverId,
              ) ? (
                <RoundButton
                  title={t('runs.openSession')}
                  testID="action-operation-open-session"
                  onPress={() => {
                    router.push(
                      createActivitySurfaceSessionRoute(
                        openSessionId,
                        readActionOperationDestinationServerId(
                          snapshot,
                          operation.serverId,
                        ),
                      ),
                    );
                    props.onClose();
                  }}
                />
              ) : null}
            </>
          }
        />
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingHorizontal: theme.space.s20,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s20,
    gap: theme.space.s12,
  },
  hero: {
    borderRadius: 14,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    backgroundColor: theme.colors.surface.elevated,
  },
  heroQuiet: {
    backgroundColor: 'transparent',
    paddingVertical: 0,
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
  statusQuiet: {
    color: theme.colors.text.secondary,
    fontWeight: '400',
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
  output: {
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s12,
  },
  cancelFeedback: {
    color: theme.colors.text.primary,
  },
}));
