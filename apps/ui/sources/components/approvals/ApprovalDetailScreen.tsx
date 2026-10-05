import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter, type Href } from 'expo-router';

import {
  approvalArtifactBodyMatchesHeaderV1,
  ExecutionRunHostActionApprovalRequestV1Schema,
  TargetActionApprovalRequestV1Schema,
  buildExecutionRunHostActionApprovalArtifactHeaderV1,
  buildTargetActionApprovalArtifactHeaderV1,
  getActionSpec,
  WorkspaceSyncConflictResolutionResultV1Schema,
  WorkspaceSyncConflictResolutionV1Schema,
  type ActionId,
  type ExecutionRunHostActionApprovalRequestV1,
  type TargetActionApprovalRequestV1,
} from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { useApprovalArtifact } from './useApprovalArtifact';
import { captureActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import {
  storage,
  useServerScopedMachine,
  useSessionListRenderableWithServerScope,
} from '@/sync/domains/state/storage';
import {
  replayApprovalRequestAtExactDaemon,
} from '@/sync/ops/actions/defaultActionExecutor';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { ApprovalSessionContextCard } from './ApprovalSessionContextCard';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import { WorkspaceSyncConflictDetailsView } from '@/components/workspaces/sync/WorkspaceSyncConflictDetailsView';
import { resolveApprovalRequestApproveAdmission } from './approvalFieldValues';
import { ApprovalPreviewCard, readApprovalPreviewSummary } from './ApprovalPreviewCard';
import { HandoffTargetConsequencesCard, describeHandoffTargetApproval } from './HandoffTargetConsequencesCard';
import { ComputerActionApprovalCard } from './ComputerActionApprovalCard';
import { useComputerApprovalChoice } from './useComputerApprovalChoice';
import { openComputerTargetPickerForSession } from '@/components/computer/openComputerTargetPickerForSession';

import { SessionStoredImageThumbnail } from '@/components/sessions/media/SessionStoredImageThumbnail';
import { readApprovalSessionEndpointLabels, readApprovalTargetEndpointLabels } from './approvalEndpointLabels';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
  getApprovalDecisionErrorMessage,
  isApprovalReplayRouteUnavailable,
  resolveApprovalReplayRoute,
  useApprovalDecisionHandler,
} from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import { useRetargetNavigationFocusReturnIntent } from '@/keyboard/focusReturn';
import { useSessionListHomeObservations } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import {
  buildSessionContextFacts,
  projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';

/** The picker opener for this page's computer approvals (the page already holds the store). */
const resolveComputerPicker = () => openComputerTargetPickerForSession;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface.base,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  recoveryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 12,
    marginTop: 12,
  },
  // The decision closes the page: one primary (approve), the withdrawal quiet, rejection last.
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  actionsStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  actionFullWidth: {
    width: '100%',
  },
}));

function formatApprovalStatusLabel(status: string): string {
  switch (status) {
    case 'open':
      return t('approvals.status.open');
    case 'approved':
      return t('approvals.status.approved');
    case 'executing':
      return t('approvals.status.executing');
    case 'rejected':
      return t('approvals.status.rejected');
    case 'executed':
      return t('approvals.status.executed');
    case 'failed':
      return t('approvals.status.failed');
    case 'canceled':
      return t('approvals.status.canceled');
    default:
      return status;
  }
}

export const ApprovalDetailScreen = React.memo((props: Readonly<{
  artifactId: string;
  serverId?: string;
  completionHref?: Href;
  completionFocusFrom?: string;
  completionFocusTo?: string;
}>) => {
  const router = useRouter();
  const retargetNavigationFocusReturn = useRetargetNavigationFocusReturnIntent();
  const { theme } = useUnistyles();
  // A route-carried Home is authoritative for background Homes. Without one,
  // retain the incumbent singleton artifact reader; an unrelated active Home
  // is not evidence that this artifact belongs there.
  const [requestedServerId] = React.useState(() => props.serverId?.trim() || null);
  const {
    artifact,
    isLoading,
    homeUnavailable,
    error: loadError,
    refresh: refreshArtifact,
  } = useApprovalArtifact({
    artifactId: props.artifactId, serverId: requestedServerId,
  });
  const error = loadError
    ? homeUnavailable
      ? t('actionConfirmations.homeUnavailable')
      : t('approvals.loadError')
    : null;
  const [isDeciding, setIsDeciding] = React.useState(false);
  const decisionInFlightRef = React.useRef(false);

  const parsed = React.useMemo(() => {
    if (!artifact || typeof artifact.body !== 'string') return null;
    const matched = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
    if (matched?.family === 'execution_run_host_action') return { kind: 'host_action' as const, request: matched.request };
    if (matched?.family === 'target_action') return { kind: 'target' as const, request: matched.request };
    if (matched?.family === 'built_in') return { kind: 'built_in' as const, request: matched.request };
    return null;
  }, [artifact]);
  const completionHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (completionHandledRef.current || parsed?.request.status !== 'executed' || !props.completionHref) return;
    completionHandledRef.current = true;
    if (props.completionFocusFrom && props.completionFocusTo) {
      retargetNavigationFocusReturn(props.completionFocusFrom, props.completionFocusTo);
    }
    router.dismissTo(props.completionHref);
  }, [parsed?.request.status, props.completionFocusFrom, props.completionFocusTo, props.completionHref, retargetNavigationFocusReturn, router]);

  const actionTitle = React.useMemo(() => {
    const actionId = parsed?.kind === 'built_in' || parsed?.kind === 'host_action'
      ? parsed.request.actionId
      : null;
    if (!actionId) return null;
    try {
      const spec = getActionSpec(actionId as ActionId);
      return spec.title || actionId;
    } catch {
      return actionId;
    }
  }, [parsed]);

  // One reading of the arguments decides both what the card shows and whether the
  // decision may be taken, so an invisible field can never sit behind a live
  // Approve button.
  const builtInApproveAdmission = React.useMemo(() => (
    parsed?.kind === 'built_in'
      ? resolveApprovalRequestApproveAdmission(parsed.request)
      : null
  ), [parsed]);
  const actionFields = builtInApproveAdmission?.presentation ?? null;
  const approvalWithheld = builtInApproveAdmission?.status === 'unavailable';

  const request = parsed?.request ?? null;
  const requesterSurface = parsed?.kind === 'built_in'
    ? parsed.request.v === 2
      ? parsed.request.executionOriginV1.surface
      : parsed.request.requestedSurface ?? ''
    : parsed?.request.createdBy.surface ?? '';
  const sessionId = parsed?.kind === 'built_in'
    ? parsed.request.v === 2
      ? parsed.request.executionOriginV1.sessionId ?? parsed.request.createdBy.sessionId ?? ''
      : parsed.request.createdBy.sessionId ?? ''
    : parsed?.kind === 'target'
      ? parsed.request.executionOriginV1?.sessionId
        ?? parsed.request.replayPlacement?.defaultSessionId
        ?? parsed.request.createdBy.sessionId
        ?? ''
      : parsed?.kind === 'host_action'
        ? parsed.request.sessionId
        : '';
  const builtInReplayRoute = React.useMemo(
    () => resolveApprovalReplayRoute(parsed?.kind === 'built_in' ? parsed.request : null),
    [parsed],
  );
  const approvalServerId = React.useMemo(() => {
    if (!parsed) return null;
    if (parsed.kind === 'built_in' && parsed.request.v === 2) {
      return (builtInReplayRoute?.serverId
        ?? requestedServerId
        ?? parsed.request.executionOriginV1.serverId.trim()) || null;
    }
    if (parsed.kind === 'target') {
      return parsed.request.executionOriginV1?.serverId
        ?? parsed.request.replayPlacement?.serverId
        ?? requestedServerId;
    }
    if (parsed.kind === 'host_action') return parsed.request.serverId;
    const requestServerId = parsed.kind === 'built_in'
      ? typeof (parsed.request as { serverId?: unknown }).serverId === 'string'
          ? String((parsed.request as { serverId?: string }).serverId).trim()
          : ''
      : '';
    if (requestServerId.length > 0) return requestServerId;
    if (requestedServerId) return requestedServerId;
    return sessionId ? resolvePreferredServerIdForSessionId(sessionId) ?? null : null;
  }, [builtInReplayRoute?.serverId, parsed, requestedServerId, sessionId]);
  const approvedWorkspaceSyncResolution = React.useMemo(() => {
    if (parsed?.kind !== 'built_in' || parsed.request.v !== 2
      || parsed.request.actionId !== 'workspace.sync.conflict.resolve') return null;
    const result = WorkspaceSyncConflictResolutionV1Schema.safeParse(parsed.request.actionArgs);
    return result.success ? result.data : null;
  }, [parsed]);
  const reportedWorkspaceSyncOutcome = React.useMemo(() => {
    if (!approvedWorkspaceSyncResolution || parsed?.kind !== 'built_in'
      || parsed.request.status !== 'executed' || !parsed.request.execution?.ok) return null;
    const result = WorkspaceSyncConflictResolutionResultV1Schema.safeParse(parsed.request.execution.result);
    return result.success ? result.data : null;
  }, [approvedWorkspaceSyncResolution, parsed]);
  const approvalOriginHomeId = parsed?.kind === 'built_in' && parsed.request.v === 2
    ? [
        parsed.request.executionOriginV1.serverIdentityId?.trim(),
        parsed.request.executionOriginV1.serverId.trim(),
      ].filter((value): value is string => Boolean(value)).join(' · ')
    : approvalServerId;
  const approvalRouteUnavailable = parsed?.kind === 'built_in'
    && isApprovalReplayRouteUnavailable(parsed.request);
  const decideBuiltInApproval = useApprovalDecisionHandler(
    { id: artifact?.id ?? props.artifactId, header: artifact?.header ?? null },
    parsed?.kind === 'built_in' ? parsed.request : null,
    sessionId,
    approvalServerId,
  );
  const session = useSessionListRenderableWithServerScope(
    approvalServerId,
    approvalServerId ? sessionId : '',
  );
  const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
  const machineId = readDisplayMachineIdForSession({
    sessionId: null,
    metadata: ownerMetadata,
  });
  const machine = useServerScopedMachine(approvalServerId, approvalServerId ? machineId : '');
  const approvalScopeResolution = useServerCredentialAccountScopeResolution(approvalServerId);
  const homeObservations = useSessionListHomeObservations();
  const contextNowMs = Date.now();
  const sessionContext = approvalServerId && session
    ? projectSessionContextPresentation(buildSessionContextFacts({
        address: { serverId: approvalServerId, sessionId },
        serverProfile: getServerProfileById(approvalServerId),
        awareness: projectUiSessionAwareness(session, contextNowMs),
        viewer: session.viewer,
        audienceContext: session.access?.audienceContext,
        audienceScope: approvalScopeResolution.kind === 'bound' ? approvalScopeResolution.scope : null,
        homeDir: ownerMetadata?.homeDir ?? null,
        homeObservation: homeObservations[approvalServerId] ?? null,
        nowMs: contextNowMs,
      }))
    : null;
  const computerChoice = useComputerApprovalChoice({
    actionId: parsed?.kind === 'built_in' ? String(parsed.request.actionId) : '',
    actionArgs: parsed?.kind === 'built_in' ? parsed.request.actionArgs : null,
    preview: parsed?.kind === 'built_in' ? parsed.request.preview : null,
    sessionId,
    serverId: approvalServerId,
    resolveOpenPicker: resolveComputerPicker,
  });
  const computerAction = computerChoice.presentation;
  const chooseComputerTarget = computerChoice.chooseTarget;
  const computerCaptureMedia = computerAction?.captureMedia ?? null;
  const computerCropMedia = React.useMemo(() => (computerCaptureMedia ? [{
    id: computerCaptureMedia.mediaId,
    name: computerAction?.target?.title ?? '',
    path: computerCaptureMedia.file.path,
    mimeType: computerCaptureMedia.file.mimeType,
    sizeBytes: computerCaptureMedia.sizeBytes,
    sha256: computerCaptureMedia.file.sha256,
    width: computerCaptureMedia.width,
    height: computerCaptureMedia.height,
    category: 'tool-artifact' as const,
    role: 'output' as const,
  }] : []), [computerAction?.target?.title, computerCaptureMedia]);
  const handoffTargetApproval = parsed?.kind === 'built_in'
    ? parsed.request.handoffTargetReplacementApproval ?? null
    : null;
  const handoffTargetActionArgs = parsed?.kind === 'built_in' ? parsed.request.actionArgs : null;
  const handoffTargetServerId = handoffTargetApproval?.serverId ?? approvalServerId;
  const handoffTargetMachine = useServerScopedMachine(
    handoffTargetServerId,
    handoffTargetServerId ? handoffTargetApproval?.machineId ?? '' : '',
  );
  const handoffTargetPresentation = React.useMemo(() => (
    handoffTargetApproval
      ? describeHandoffTargetApproval({
        approval: handoffTargetApproval,
        actionArgs: handoffTargetActionArgs,
        source: sessionContext
          ? {
              machineLabel: readApprovalSessionEndpointLabels({ session, machine, machineId }).machineLabel,
              pathLabel: sessionContext.workspace?.label ?? null,
            }
          : readApprovalSessionEndpointLabels({ session, machine, machineId }),
        destination: readApprovalTargetEndpointLabels({
          machineId: handoffTargetApproval.machineId,
          machine: handoffTargetMachine,
          canonicalRoot: handoffTargetApproval.canonicalRoot,
        }),
      })
      : null
  ), [handoffTargetApproval, handoffTargetActionArgs, handoffTargetMachine, machine, machineId, session, sessionContext]);
  const decide = React.useCallback(
    async (decision: 'approve' | 'reject' | 'cancel') => {
      if (!parsed || decisionInFlightRef.current || parsed.request.status !== 'open') return;
      // Fails closed for a programmatic press too, not only for the dimmed control.
      if (decision === 'approve' && approvalWithheld) return;

      try {
        decisionInFlightRef.current = true;
        setIsDeciding(true);
        if (parsed.kind === 'target') {
          if (parsed.request.replayPlacement !== undefined && decision !== 'cancel') {
            const replay = await replayApprovalRequestAtExactDaemon({
              artifactId: props.artifactId,
              decision,
              executionTarget: parsed.request.replayPlacement,
            });
            if (replay !== null
              && typeof replay === 'object'
              && 'ok' in replay
              && replay.ok === false) {
              const errorCode = 'errorCode' in replay && typeof replay.errorCode === 'string'
                ? replay.errorCode
                : 'approval_decision_failed';
              throw new Error(errorCode);
            }
            await refreshArtifact();
            return;
          }
          const now = Date.now();
          const nextRequest: TargetActionApprovalRequestV1 = decision === 'cancel'
            ? { ...parsed.request, status: 'canceled', updatedAtMs: now }
            : {
              ...parsed.request,
              status: decision === 'approve' ? 'approved' : 'rejected',
              updatedAtMs: now,
              decision: { kind: decision, decidedAtMs: now },
            };
          const validated = TargetActionApprovalRequestV1Schema.parse(nextRequest);
          const header = buildTargetActionApprovalArtifactHeaderV1(validated);
          if (requestedServerId) {
            const context = await captureActionAccountContext(requestedServerId);
            try { await context.updateArtifact(props.artifactId, header, JSON.stringify(validated)); }
            finally { context.dispose(); }
          } else { await sync.updateArtifactWithHeader(props.artifactId, header, JSON.stringify(validated)); }
        } else if (parsed.kind === 'host_action') {
          const now = Date.now();
          const nextRequest: ExecutionRunHostActionApprovalRequestV1 = decision === 'cancel'
            ? { ...parsed.request, status: 'canceled', updatedAtMs: now }
            : {
              ...parsed.request,
              status: decision === 'approve' ? 'approved' : 'rejected',
              updatedAtMs: now,
              decision: { kind: decision, decidedAtMs: now },
            };
          const validated = ExecutionRunHostActionApprovalRequestV1Schema.parse(nextRequest);
          const header = buildExecutionRunHostActionApprovalArtifactHeaderV1(validated);
          if (requestedServerId) {
            const context = await captureActionAccountContext(requestedServerId);
            try { await context.updateArtifact(props.artifactId, header, JSON.stringify(validated)); }
            finally { context.dispose(); }
          } else { await sync.updateArtifactWithHeader(props.artifactId, header, JSON.stringify(validated)); }
        } else {
          if (decision === 'cancel') return;
          // An agent's window choice is approved with the exact window the person picked.
          if (decision === 'approve' && computerChoice.needsChoiceBeforeApprove) {
            computerChoice.chooseTarget();
            return;
          }
          if (!await decideBuiltInApproval(decision, decision === 'approve' ? computerChoice.decisionOptions : undefined)) {
            throw new Error('approval_decision_failed');
          }
        }
        await refreshArtifact();
      } catch (err) {
        const isVersionConflict = err instanceof Error && err.message.includes('modified by another client');
        if (isVersionConflict) {
          try {
            await refreshArtifact();
          } catch {
            // The original conflict remains authoritative and is still shown below.
          }
        }
        const message = isVersionConflict ? err.message : getApprovalDecisionErrorMessage(err);
        Modal.alert(t('common.error'), message);
      } finally {
        decisionInFlightRef.current = false;
        setIsDeciding(false);
      }
    },
    [approvalWithheld, computerChoice, decideBuiltInApproval, parsed, props.artifactId, refreshArtifact, requestedServerId, sessionId],
  );

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <ActivitySpinner size="large" color={theme.colors.text.secondary} />
        </View>
      </View>
    );
  }

  if (artifact?.isDecrypted === false) {
    const lockedMessage = artifact.availability.reason === 'encryption_material_unavailable'
      ? t('settingsAccount.secretKeyMissing')
      : t('approvals.loadError');

    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.text.secondary }}>{lockedMessage}</Text>
          <View style={{ height: 12 }} />
          <RoundButton
            size="normal"
            display="secondary"
            title={t('common.back')}
            onPress={() => router.back()}
          />
        </View>
      </View>
    );
  }

  if (error || !parsed) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.text.secondary }}>{error || t('approvals.loadError')}</Text>
          <View style={styles.recoveryActions}>
            {error ? (
              <RoundButton
                testID="approvals.retry"
                size="normal"
                title={t('common.retry')}
                accessibilityLabel={t('common.retry')}
                onPress={() => void refreshArtifact()}
              />
            ) : null}
            <RoundButton
              size="normal"
              display="secondary"
              title={t('common.back')}
              accessibilityLabel={t('common.back')}
              onPress={() => router.back()}
            />
          </View>
        </View>
      </View>
    );
  }

  const statusLabel = formatApprovalStatusLabel(parsed.request.status);
  const targetActionParts = parsed.kind === 'target'
    ? parsed.request.qualifiedActionId.split('/actions/')
    : null;
  const executionFailure = parsed.kind === 'host_action'
    || parsed.request.status !== 'failed'
    || parsed.request.execution?.ok !== false
    ? null
    : parsed.request.execution.error || parsed.request.execution.errorCode || null;
  // Who is asking for what: the plugin and action of a target request, or the plugin and proposal
  // count of a host action. The action's name and exact identifiers are the Action row.
  const headerFacts: PageHeaderMetaFact[] = [];
  if (targetActionParts) {
    headerFacts.push({ key: 'target-source', text: targetActionParts[0] ?? '' });
    if (targetActionParts[1]) headerFacts.push({ key: 'target-action', text: targetActionParts[1] });
  }
  if (parsed.kind === 'host_action') {
    headerFacts.push({ key: 'plugin', text: parsed.request.pluginId });
    headerFacts.push({ key: 'proposals', text: t('approvals.proposedComments', { count: parsed.request.proposalCount }) });
  }
  const actionValue = actionTitle ?? (parsed.kind === 'target' ? parsed.request.qualifiedActionId : String(parsed.request.actionId));
  const actionIdentifiers = [
    actionTitle && parsed.kind === 'built_in' && actionTitle !== parsed.request.actionId ? String(parsed.request.actionId) : null,
    parsed.kind === 'host_action' ? parsed.request.actionId : null,
    parsed.kind === 'target' ? parsed.request.sourceCustody.kind : null,
    parsed.kind === 'host_action' ? parsed.request.profileId : null,
  ].filter((value): value is string => Boolean(value));
  const previewSummary = parsed.kind === 'built_in' ? readApprovalPreviewSummary(parsed.request.preview) : null;

  return (
    <ItemList>
      <PageHeader
        testID="approvals.header"
        alwaysShowTitle
        title={parsed.request.summary || t('approvals.untitled')}
        description={parsed.kind === 'target' && parsed.request.detail ? parsed.request.detail : undefined}
        meta={headerFacts.length > 0 ? headerFacts : undefined}
      />

      <ItemGroup
        title={t('detailPages.approval.requestTitle')}
        description={t('detailPages.approval.requestDescription')}
      >
        {parsed.kind === 'built_in' && previewSummary ? (
          <SectionContentRow testID="approvals.preview">
            <ApprovalPreviewCard preview={parsed.request.preview} />
          </SectionContentRow>
        ) : null}
        <Item
          testID="approvals.action"
          title={t('approvals.fieldAction')}
          subtitle={[actionValue, ...actionIdentifiers].join(' · ')}
          subtitleLines={0}
          mode="info"
          showChevron={false}
        />
        <Item
          testID="approvals.status"
          title={t('approvals.fieldStatus')}
          detail={statusLabel}
          mode="info"
          showChevron={false}
        />
        {executionFailure ? (
          <Item
            testID="approvals.execution-failure"
            title={t('detailPages.approval.failureTitle')}
            subtitle={executionFailure}
            subtitleLines={0}
            mode="info"
            showChevron={false}
          />
        ) : null}
        {approvalRouteUnavailable ? (
          <Item
            testID="approvals.home-unavailable"
            title={t('detailPages.approval.homeUnavailableTitle')}
            subtitle={t('actionConfirmations.homeUnavailable')}
            subtitleLines={0}
            mode="info"
            showChevron={false}
          />
        ) : null}
      </ItemGroup>

      <ApprovalSessionContextCard
        session={session}
        machine={machine}
        serverId={approvalServerId}
        context={sessionContext}
        homeDisplayId={approvalOriginHomeId}
        requesterAgentId={parsed.request.createdBy.agentId ?? null}
        requesterSurface={requesterSurface}
      />

      {computerAction ? (
        <ItemGroup title={t('computerUse.approval.sectionTitle')}>
          <SectionContentRow>
            <ComputerActionApprovalCard
              presentation={computerAction}
              onChooseTarget={chooseComputerTarget}
              media={computerCaptureMedia ? (
                <SessionStoredImageThumbnail
                  sessionId={computerCaptureMedia.file.sessionId}
                  serverId={approvalServerId}
                  machineId={computerAction.machineId}
                  storage={computerCaptureMedia.file.storage}
                  media={computerCropMedia}
                  mediaPreviewEnabled
                  testID="approvals.computer-action-crop"
                />
              ) : undefined}
            />
          </SectionContentRow>
        </ItemGroup>
      ) : null}

      {handoffTargetPresentation ? (
        <ItemGroup title={t('sessionHandoff.targetApproval.title')}>
          <SectionContentRow>
            <HandoffTargetConsequencesCard presentation={handoffTargetPresentation} />
          </SectionContentRow>
        </ItemGroup>
      ) : null}

      {actionFields ? (
        <ItemGroup surface="none">
          <ActionApprovalFieldsCard presentation={actionFields} />
        </ItemGroup>
      ) : null}

      {approvedWorkspaceSyncResolution ? (
        <ItemGroup surface="none">
          <View testID="workspace-sync-approved-review">
            <WorkspaceSyncConflictDetailsView
              embedded
              approvedRequest={approvedWorkspaceSyncResolution}
              reportedOutcome={reportedWorkspaceSyncOutcome ?? undefined}
              resource={{ kind: 'workspaceSyncConflicts',
                hubWorkspaceRefId: approvedWorkspaceSyncResolution.hubWorkspaceRefId,
                workspaceRefId: approvedWorkspaceSyncResolution.source.workspaceRefId,
                controllerMachineId: approvedWorkspaceSyncResolution.controllerMachineId,
                serverId: approvalServerId,
                initialPath: approvedWorkspaceSyncResolution.path }}
            />
          </View>
        </ItemGroup>
      ) : null}

      {parsed.kind === 'host_action' && parsed.request.proposalPreview.length > 0 ? (
        <ItemGroup
          title={t('approvals.proposedComments', { count: parsed.request.proposalCount })}
          description={t('detailPages.approval.proposalsDescription')}
        >
          {parsed.request.proposalPreview.map((proposal, index) => (
            <Item
              key={`${proposal.pathSha256}:${proposal.bodySha256}:${index}`}
              title={`${proposal.pathLabel}${proposal.startLine ? `:${proposal.startLine}` : ''}`}
              subtitle={proposal.bodyPreview}
              subtitleLines={0}
              detail={proposal.severity ?? undefined}
              mode="info"
              showChevron={false}
            />
          ))}
        </ItemGroup>
      ) : null}

      {parsed.request.status === 'open' ? (
        <ItemGroup surface="none">
          <View
            testID="approvals.actions"
            style={[styles.actionsRow, handoffTargetPresentation ? styles.actionsStack : null]}
          >
            <RoundButton
              testID="approvals.approve"
              size="normal"
              title={handoffTargetPresentation?.decisionLabel ?? t('approvals.approve')}
              accessibilityLabel={handoffTargetPresentation?.decisionLabel ?? t('approvals.approve')}
              titleNumberOfLines={handoffTargetPresentation ? 'complete' : 1}
              disabled={isDeciding || approvalWithheld || approvalRouteUnavailable}
              accessibilityHint={approvalRouteUnavailable
                ? t('actionConfirmations.homeUnavailable')
                : approvalWithheld ? t('approvals.approveUnavailableHint') : undefined}
              style={handoffTargetPresentation ? styles.actionFullWidth : undefined}
              onPress={() => decide('approve')}
            />
            {parsed.kind === 'target' || parsed.kind === 'host_action' ? (
              <RoundButton
                testID="approvals.cancel"
                size="normal"
                display="secondary"
                title={t('common.cancel')}
                accessibilityLabel={t('common.cancel')}
                titleNumberOfLines={handoffTargetPresentation ? 'complete' : 1}
                disabled={isDeciding}
                style={handoffTargetPresentation ? styles.actionFullWidth : undefined}
                onPress={() => decide('cancel')}
              />
            ) : null}
            <RoundButton
              testID="approvals.reject"
              size="normal"
              display="destructive"
              title={t('approvals.reject')}
              accessibilityLabel={t('approvals.reject')}
              titleNumberOfLines={handoffTargetPresentation ? 'complete' : 1}
              disabled={isDeciding || approvalRouteUnavailable}
              accessibilityHint={approvalRouteUnavailable ? t('actionConfirmations.homeUnavailable') : undefined}
              style={handoffTargetPresentation ? styles.actionFullWidth : undefined}
              onPress={() => decide('reject')}
            />
          </View>
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

ApprovalDetailScreen.displayName = 'ApprovalDetailScreen';
