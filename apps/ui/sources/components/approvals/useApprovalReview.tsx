import * as React from 'react';
import { View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { approvalArtifactBodyMatchesHeaderV1, buildExecutionRunHostActionApprovalArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { ExecutionRunHostActionApprovalRequestV1Schema, type ExecutionRunHostActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { ApprovalRequesterConfirmationV1Schema, isSessionDiscussionApprovalPublicationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { WorkspaceSyncConflictResolutionResultV1Schema, WorkspaceSyncConflictResolutionV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { ApprovalDecisionBar } from './ApprovalDecisionBar';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { useApprovalArtifact } from './useApprovalArtifact';
import { captureActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import {
  storage,
  useServerScopedMachine,
} from '@/sync/domains/state/storage';
import {
  replayApprovalRequestAtExactDaemon,
} from '@/sync/ops/actions/defaultActionExecutor';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { ApprovalSessionContextCard } from './ApprovalSessionContextCard';
import { ApprovalRequesterConfirmationSection, useApprovalRequesterViewer } from './ApprovalRequesterConfirmationSection';
import { readApprovalOperationCredentialUses } from './approvalRequesterThreadState';
import { readApprovalRequesterSurface, resolveApprovalHomeName } from './approvalRequesterLabels';
import { ApprovalAcceptedOperationStatusRow, BrowserOpenOperationStatusRow } from './BrowserOpenOperationStatus';
import { ActionApprovalFieldsCard, ApprovalTechnicalDetails } from './ActionApprovalFieldsCard';
import {
  ProjectCommandApprovalFacts,
  describeProjectCommandApprovalDecisions,
  readProjectCommandApproval,
  useProjectCommandApprovalTitle,
} from './ProjectCommandApprovalFacts';
import { readApprovalArtifactTitleInput, useApprovalRequestTitle } from './approvalRequestTitle';
import { formatApprovalStatusLabel, resolveApprovalDisplayStatus } from './approvalStatusLabel';
import { WorkspaceSyncConflictDetailsView } from '@/components/workspaces/sync/WorkspaceSyncConflictDetailsView';
import { describeApprovalRequestFields, resolveApprovalRequestApproveAdmission } from './approvalFieldValues';
import { ApprovalPreviewCard } from './ApprovalPreviewCard';
import { readApprovalPreviewSummary } from './actionApprovalPresentation';
import { ApprovalVisualPreview } from './ApprovalVisualPreview';
import { HandoffTargetConsequencesCard, describeHandoffTargetApproval } from './HandoffTargetConsequencesCard';
import { ComputerActionApprovalCard } from './ComputerActionApprovalCard';
import { CapabilityEnableDetailsDecisions } from '@/components/sessions/capabilities/CapabilityEnableApproval';
import { ResourceProposalBody } from './resourceProposal/ResourceProposalBody';
import { resolveResourceProposalLabels } from './resourceProposal/resourceProposalLabels';
import { useResourceProposalCheck } from './resourceProposal/useResourceProposalCheck';
import { ConfidentialSecretApproval } from './ConfidentialSecretApproval';
import { readActionApprovalReview } from './actionApprovalReview';
import { useComputerApprovalChoice } from './useComputerApprovalChoice';
import { openComputerTargetPickerForSession } from '@/components/computer/openComputerTargetPickerForSession';

import { SessionStoredImageThumbnail } from '@/components/sessions/media/SessionStoredImageThumbnail';
import { readApprovalOriginMachineId, readApprovalSessionEndpointLabels, readApprovalTargetEndpointLabels } from './approvalEndpointLabels';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
  alertApprovalFailure,
  ApprovalExecutionError,
  assertApprovalExecutionSucceeded,
  presentRecordedApprovalFailure,
  isApprovalDecisionStale,
  isApprovalReplayRouteUnavailable,
  useApprovalHome,
  useApprovalDecisionHandler,
} from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import { presentApprovalFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { useRetargetNavigationFocusReturnIntent } from '@/keyboard/focusReturn';
import { useApprovalSessionReading } from './useApprovalSessionReading';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import {
  buildSessionContextFacts,
  projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';

/** The picker opener for this page's computer approvals (the page already holds the store). */
const resolveComputerPicker = () => openComputerTargetPickerForSession;

export type ApprovalReviewInput = Readonly<{
  artifactId: string;
  serverId?: string;
  completionHref?: Href;
  completionFocusFrom?: string;
  completionFocusTo?: string;
  /** Where "Back" goes when the request cannot be shown: the host closes its pane (the Inbox's detail); a route goes back. */
  onBack?: () => void;
}>;

/** The incumbent Inbox review and decision controller, shared with in-place review chrome. */
export function useApprovalReview(props: ApprovalReviewInput) {
  const router = useRouter();
  const goBack = props.onBack ?? router.back;
  const retargetNavigationFocusReturn = useRetargetNavigationFocusReturnIntent();
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
  const [recordedAnswer, setRecordedAnswer] = React.useState<Readonly<{
    artifactId: string; decision: 'approve' | 'reject' | 'cancel';
  }> | null>(null);
  const recordedDecision = recordedAnswer?.artifactId === props.artifactId ? recordedAnswer.decision : null;
  const setRecordedDecision = React.useCallback((decision: 'approve' | 'reject' | 'cancel') => {
    setRecordedAnswer({ artifactId: props.artifactId, decision });
  }, [props.artifactId]);
  const decisionInFlightRef = React.useRef(false);

  const matchedBody = React.useMemo(() => artifact && typeof artifact.body === 'string'
    ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null, [artifact]);
  const parsed = React.useMemo(() => {
    const matched = matchedBody;
    if (matched?.family === 'execution_run_host_action') return { kind: 'host_action' as const, request: matched.request };
    if (matched?.family === 'target_action') return { kind: 'target' as const, request: matched.request };
    if (matched?.family === 'built_in') return { kind: 'built_in' as const, request: matched.request };
    return null;
  }, [matchedBody]);
  const builtInExecutionFailure = React.useMemo(() => (
    parsed?.kind === 'built_in' ? readApprovalExecutionFailure(parsed.request) : null
  ), [parsed]);
  const completionHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (completionHandledRef.current || parsed?.request.status !== 'executed' || builtInExecutionFailure || !props.completionHref) return;
    completionHandledRef.current = true;
    if (props.completionFocusFrom && props.completionFocusTo) {
      retargetNavigationFocusReturn(props.completionFocusFrom, props.completionFocusTo);
    }
    router.dismissTo(props.completionHref);
  }, [parsed?.request.status, builtInExecutionFailure, props.completionFocusFrom, props.completionFocusTo, props.completionHref, retargetNavigationFocusReturn, router]);


  // One reading of the arguments decides both what the card shows and whether the
  // decision may be taken, so an invisible field can never sit behind a live
  // Approve button.
  const review = React.useMemo(() => parsed?.kind === 'built_in' ? readActionApprovalReview(parsed.request) : null, [parsed]);
  const approveAdmission = review?.admission ?? (parsed?.kind === 'target' && parsed.request.status === 'open'
    ? resolveApprovalRequestApproveAdmission(parsed.request) : null);
  const actionFields = React.useMemo(() => approveAdmission?.presentation
    ?? (parsed?.kind === 'built_in' || parsed?.kind === 'target' ? describeApprovalRequestFields(parsed.request) : null), [approveAdmission, parsed]);
  // A Project's setup or command reads as the machine and the exact command, not as its protocol operands.
  const projectCommand = React.useMemo(
    () => (parsed?.kind === 'built_in' ? readProjectCommandApproval(parsed.request) : null),
    [parsed],
  );
  const projectCommandTitle = useProjectCommandApprovalTitle(projectCommand);
  const projectCommandDecisions = projectCommand ? describeProjectCommandApprovalDecisions(projectCommand) : null;
  // An agent's private Discussion draft is decided as what it does there: Post it, or Decline it (C3 §6).
  const discussionDraftDecisions = React.useMemo(() => (
    parsed?.kind === 'built_in' && isSessionDiscussionApprovalPublicationV1(parsed.request)
      ? { approve: t('session.collaboration.discussion.draftReview.post'), reject: t('session.collaboration.discussion.draftReview.decline') }
      : null), [parsed]);
  // An Agent's enable request is decided by its own controller here too: Allow · Always in <place> · Not now (P8 U8.5).
  const capabilityEnable = review?.capabilityEnable ?? null;
  const approvalWithheld = approveAdmission?.status === 'unavailable';

  const request = parsed?.request ?? null;
  const confidentialAction = review?.confidentialAction ?? false;
  const confidentialApproval = review?.confidential ?? null;
  const confidentialInputs = review?.confidentialInputs ?? null;
  const secretPrompt = confidentialAction || confidentialInputs !== null;
  const confidentialPrompt = confidentialApproval ?? confidentialInputs;
  const confidentialReviewKey = (confidentialApproval || confidentialInputs) && parsed?.kind === 'built_in'
    ? JSON.stringify([parsed.request.actionId, parsed.request.actionArgs,
        parsed.request.v === 2 ? parsed.request.executionOriginV1 : null, parsed.request.createdBy])
    : null;
  const requesterSurface = readApprovalRequesterSurface(parsed?.request ?? null, parsed?.kind === 'built_in');
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
  // Requested by already names an ordinary same-Session target, so keep only its exact id in the
  // disclosure. A destructive target must remain readable before the person acts.
  const shownActionFields = React.useMemo(() => actionFields && sessionId ? {
    ...actionFields,
    rows: actionFields.rows.map(row => row.kind === 'value' && row.reference?.kind === 'session'
      && row.reference.id === sessionId && row.reference.presentation !== 'destructive_target'
      ? { ...row, technical: true as const } : row),
  } : actionFields, [actionFields, sessionId]);
  const { replayRoute } = useApprovalHome(
    { id: artifact?.id ?? props.artifactId, header: artifact?.header ?? null },
    parsed?.kind === 'built_in' || parsed?.kind === 'target' ? parsed.request : null,
    sessionId,
    requestedServerId,
  );
  const approvalServerId = React.useMemo(() => {
    if (!parsed) return null;
    if (parsed.kind === 'built_in' && parsed.request.v === 2) {
      return (replayRoute?.serverId
        ?? requestedServerId
        ?? parsed.request.executionOriginV1.serverId.trim()) || null;
    }
    if (parsed.kind === 'target') {
      return replayRoute?.serverId ?? requestedServerId;
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
  }, [replayRoute?.serverId, parsed, requestedServerId, sessionId]);
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
    ? joinHappierFacts(
        parsed.request.executionOriginV1.serverIdentityId?.trim(),
        parsed.request.executionOriginV1.serverId.trim(),
      )
    : approvalServerId;
  const approvalRouteUnavailable = homeUnavailable || (parsed?.kind === 'built_in'
    && isApprovalReplayRouteUnavailable(parsed.request));
  // The Home is named as the person knows it. Its exact identity stays the fallback: when this
  // device has no profile for it, or the saved route no longer matches the Home that asked.
  const approvalHomeKnown = Boolean(approvalServerId && !approvalRouteUnavailable && getServerProfileById(approvalServerId));
  const approvalHomeName = approvalHomeKnown ? resolveApprovalHomeName(approvalServerId) : null;
  const decideActionApproval = useApprovalDecisionHandler(
    { id: artifact?.id ?? props.artifactId, header: artifact?.header ?? null },
    parsed?.kind === 'built_in' || parsed?.kind === 'target' && parsed.request.requesterConfirmation ? parsed.request : null,
    sessionId,
    approvalServerId,
  );
  // C7: a shared Bot's outward request waits for the one person who asked; others read who can act.
  const requesterConfirmation = React.useMemo(() => {
    const subject = ApprovalRequesterConfirmationV1Schema.safeParse(parsed?.kind === 'target'
      || parsed?.kind === 'built_in' && parsed.request.v === 2 ? parsed.request.requesterConfirmation : undefined);
    return subject.success ? subject.data : null;
  }, [parsed]);
  const requesterMayDecide = useApprovalRequesterViewer(requesterConfirmation, approvalServerId);
  const requesterOperationCredentialUses = React.useMemo(() => readApprovalOperationCredentialUses(
    parsed?.kind === 'target' ? parsed.request.execution
      : parsed?.kind === 'built_in' && parsed.request.v === 2 ? parsed.request.execution : undefined), [parsed]);
  // An agent's cleanup or stop proposal reads as the same card body as in the transcript (AGW-6).
  const proposal = useResourceProposalCheck(parsed?.kind === 'built_in' ? parsed.request : null, approvalServerId, props.artifactId);
  const proposalLabels = proposal ? resolveResourceProposalLabels(proposal) : null;
  const { resolution: approvalScopeResolution, binding: approvalAccountLifetime } = useServerCredentialAccountScopeBinding(approvalServerId);
  const { session, name: requesterName, status: requesterStatus, homeObservation } = useApprovalSessionReading(approvalServerId, sessionId, approvalScopeResolution, { exactRead: true });
  const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
  const machineId = readDisplayMachineIdForSession({
    sessionId: null,
    metadata: ownerMetadata,
  }) || readApprovalOriginMachineId(matchedBody);
  const machine = useServerScopedMachine(approvalServerId, approvalServerId ? machineId : '');
  // Context currentness is source-owned. Its relative age subscribes only at the context-line leaf.
  const contextServerProfile = approvalServerId ? getServerProfileById(approvalServerId) : null;
  const contextAudienceScope = approvalScopeResolution.kind === 'bound' ? approvalScopeResolution.scope : null;
  const sessionContextFacts = React.useMemo(() => approvalServerId && session
    ? buildSessionContextFacts({
        address: { serverId: approvalServerId, sessionId },
        serverProfile: contextServerProfile,
        awareness: projectUiSessionAwareness(session, Date.now()),
        viewer: session.viewer,
        audienceContext: session.access?.audienceContext,
        audienceScope: contextAudienceScope,
        homeDir: ownerMetadata?.homeDir ?? null,
        homeObservation: homeObservation ?? null,
      })
    : null, [approvalServerId, contextAudienceScope, contextServerProfile, homeObservation, ownerMetadata?.homeDir, session, sessionId]);
  const sessionContext = React.useMemo(() => sessionContextFacts ? projectSessionContextPresentation(sessionContextFacts) : null, [sessionContextFacts]);
  const computerChoice = useComputerApprovalChoice({
    artifactId: artifact?.id ?? props.artifactId,
    actionId: parsed?.kind === 'built_in' ? String(parsed.request.actionId) : '',
    actionArgs: parsed?.kind === 'built_in' ? parsed.request.actionArgs : null,
    approvedInput: parsed?.kind === 'built_in' && parsed.request.v === 2
      && parsed.request.status !== 'open' && parsed.request.decision?.kind === 'approve'
      ? parsed.request.decision.narrowedInput : undefined,
    preview: parsed?.kind === 'built_in' ? parsed.request.preview : null,
    sessionId,
    serverId: approvalServerId,
    accountLifetime: approvalAccountLifetime,
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
    async (decision: 'approve' | 'reject' | 'cancel', choice?: Readonly<{ keepUndo?: boolean }>) => {
      if (!parsed || decisionInFlightRef.current || parsed.request.status !== 'open') return;
      // Fails closed for a programmatic press too, not only for the dimmed control.
      if (decision === 'approve' && (approvalWithheld || secretPrompt || proposal?.approveWithheld)) return;

      try {
        decisionInFlightRef.current = true;
        setIsDeciding(true);
        if (parsed.kind === 'target' && parsed.request.requesterConfirmation) {
          // Requester recipients have View; the existing Action owner carries
          // their present-person decision to the original Bot Session.
          if (!await decideActionApproval(decision)) throw new Error('approval_decision_failed');
          setRecordedDecision(decision);
        } else if (parsed.kind === 'target') {
          if (parsed.request.replayPlacement !== undefined && decision !== 'cancel') {
            if (!replayRoute) throw new HappyError('approval_origin_unavailable', false, { code: 'approval_origin_unavailable' });
            let replay: unknown;
            let replayError: unknown;
            try {
              replay = await replayApprovalRequestAtExactDaemon({
                artifactId: props.artifactId,
                decision,
                executionTarget: { ...replayRoute, machineId: parsed.request.replayPlacement.machineId },
              });
            } catch (error) { replayError = error; }
            // A failed/lost reply can follow a committed decision. Read once
            // through the existing exact-Home Artifact owner, never replay it.
            const settledArtifact = await refreshArtifact();
            const settled = settledArtifact && typeof settledArtifact.body === 'string'
              ? approvalArtifactBodyMatchesHeaderV1(settledArtifact.header ?? {}, settledArtifact.body) : null;
            if (settled?.family === 'target_action'
              && settled.request.qualifiedActionId === parsed.request.qualifiedActionId
              && settled.request.subjectFingerprint === parsed.request.subjectFingerprint
              && settled.request.decision?.kind === decision) {
              if (settled.request.execution) {
                assertApprovalExecutionSucceeded(settled.request.execution);
                return;
              }
              if (settled.request.status === 'rejected') return;
            }
            if (replayError !== undefined) throw replayError;
            if (replay !== null
              && typeof replay === 'object'
              && 'ok' in replay
              && replay.ok === false) {
              const errorCode = 'errorCode' in replay && typeof replay.errorCode === 'string'
                ? replay.errorCode
                : 'approval_decision_failed';
              throw new HappyError(errorCode, false, { code: errorCode });
            }
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
          // An agent's window choice is approved with the exact window the person picked.
          if (decision === 'approve' && computerChoice.needsChoiceBeforeApprove) {
            computerChoice.chooseTarget();
            return;
          }
          const options = proposal && decision !== 'cancel' ? proposal.decisionOptions(decision, choice)
            : decision === 'approve' ? computerChoice.decisionOptions : undefined;
          if (!await decideActionApproval(decision, options)) {
            throw new Error('approval_decision_failed');
          }
          // The decision owner accepted the answer. A request another device placed reads open
          // until its host replays the decision, so the page says the answer it recorded.
          setRecordedDecision(decision);
        }
        await refreshArtifact();
      } catch (err) {
        const isStaleDecision = isApprovalDecisionStale(err);
        const isVersionConflict = !isStaleDecision && err instanceof Error && err.message.includes('modified by another client');
        if (isVersionConflict || isStaleDecision || (err instanceof ApprovalExecutionError
          && (parsed.kind !== 'target' || parsed.request.requesterConfirmation))) {
          try {
            await refreshArtifact();
          } catch {
            // The original decision failure remains authoritative and is still shown below.
          }
        }
        if (isVersionConflict) Modal.alert(t('common.error'), err.message);
        else alertApprovalFailure(err);
      } finally {
        decisionInFlightRef.current = false;
        setIsDeciding(false);
      }
    },
    [approvalWithheld, secretPrompt, computerChoice, decideActionApproval, parsed, proposal, props.artifactId, refreshArtifact, replayRoute, requestedServerId, sessionId, setRecordedDecision],
  );

  const requestTitle = useApprovalRequestTitle(
    readApprovalArtifactTitleInput(artifact, matchedBody, [sessionId]), approvalServerId ?? null);

  if (isLoading) return { kind: 'loading' as const };
  if (artifact?.isDecrypted === false) {
    return { kind: 'locked' as const, goBack, message: artifact.availability.reason === 'encryption_material_unavailable'
      ? t('settingsAccount.secretKeyMissing') : t('approvals.loadError') };
  }
  if (error || !parsed) {
    return { kind: 'error' as const, goBack, message: error || t('approvals.loadError'),
      retry: error ? () => { void refreshArtifact(); } : null };
  }

  // Only an open request shows a recorded answer; any later stored status is the newer fact.
  const answeredWhileOpen = parsed.request.status === 'open' ? recordedDecision : null;
  // The same status projection the retained tab reads; a recorded answer applies only while open.
  const statusLabel = formatApprovalStatusLabel(answeredWhileOpen === 'approve' ? 'approved'
    : answeredWhileOpen === 'reject' ? 'rejected'
      : answeredWhileOpen === 'cancel' ? 'canceled'
        : parsed.kind === 'built_in' ? resolveApprovalDisplayStatus(parsed.request, builtInExecutionFailure)
          : parsed.request.status);
  const executionFailureResult = builtInExecutionFailure ?? (parsed.kind === 'host_action'
    || parsed.request.status !== 'failed'
    || parsed.request.execution?.ok !== false
    ? null
    : { errorCode: parsed.request.execution.errorCode, error: parsed.request.execution.error });
  // The readable reason leads; its typed code waits in the technical disclosure.
  const executionFailure = executionFailureResult
    ? presentRecordedApprovalFailure(executionFailureResult)
    : null;
  // The same outcome headline the composer card reads, so one failed request names itself alike on both.
  const failureHeadline = parsed.kind === 'built_in' && builtInExecutionFailure
    ? presentApprovalFailureOutcome(parsed.request, builtInExecutionFailure).headline
    : t('detailPages.approval.failureTitle');
  // One Technical details disclosure per page: the failure's code joins the arguments' own lines when
  // the Details card is shown, and otherwise sits with the failure.
  const failureCodeInDetails = Boolean(executionFailure?.code && shownActionFields && shownActionFields.rows.length > 0
    && !confidentialAction && !proposal && !projectCommand);
  // Only human-facing facts belong in page chrome. Target requests retain their
  // Action name in summary; qualified ids and source custody are routing evidence.
  const headerFacts: PageHeaderMetaFact[] = [];
  if (parsed.kind === 'host_action') {
    headerFacts.push({ key: 'proposals', text: t('approvals.proposedComments', { count: parsed.request.proposalCount }) });
  }
  // The one title rule shared with the Inbox row: no raw ids, a disclosure after the first line.
  const actionValue = requestTitle.actionTitle ?? requestTitle.title;
  const previewSummary = parsed.kind === 'built_in' ? readApprovalPreviewSummary(parsed.request.preview, parsed.request) : null;
  // A Session visual is approved by looking at it, not by reading its arguments.
  const visualPreview = review?.visualPreview ?? null;
  // The Action row names the Action only when the title has not already said it.
  const showActionRow = actionValue !== requestTitle.title;

  const requestGroup = (
<ItemGroup
        title={t('detailPages.approval.requestTitle')}
        description={t('detailPages.approval.requestDescription')}
      >
        {parsed.kind === 'built_in' && previewSummary ? (
          <SectionContentRow testID="approvals.preview">
            <ApprovalPreviewCard preview={parsed.request.preview} request={parsed.request} />
          </SectionContentRow>
        ) : null}
        {/* The summary says what will appear and where; the visual follows it. */}
        {visualPreview ? (
          <ApprovalVisualPreview preview={visualPreview} artifactId={props.artifactId}
            serverId={approvalServerId ?? null} testID="approvals.visual" />
        ) : null}
        {showActionRow ? (
          <Item
            testID="approvals.action"
            title={t('approvals.fieldAction')}
            subtitle={actionValue}
            subtitleLines={0}
            mode="info"
            showChevron={false}
          />
        ) : null}
        <Item
          testID="approvals.status"
          title={t('approvals.fieldStatus')}
          detail={statusLabel}
          mode="info"
          showChevron={false}
        />
        {/* Executed means the open was accepted; the bound operation says whether the page opened. */}
        {parsed.kind === 'built_in' ? (
          <BrowserOpenOperationStatusRow request={parsed.request} serverId={approvalServerId} testID="approvals.browser-open" />
        ) : null}
        {/* Likewise a detached operation (a managed Create or Delete): Executed admitted it; its row says how it went. */}
        {parsed.kind === 'built_in' ? (
          <ApprovalAcceptedOperationStatusRow request={parsed.request} serverId={approvalServerId} testID="approvals.operation" />
        ) : null}
        {executionFailure ? (
          <Item
            testID="approvals.execution-failure"
            title={failureHeadline}
            subtitle={executionFailure.reason}
            subtitleLines={0}
            mode="info"
            showChevron={false}
          />
        ) : null}
        {executionFailure?.code && !failureCodeInDetails ? (
          <ApprovalTechnicalDetails
            lines={[{ key: 'failure-code', label: t('common.error'), value: executionFailure.code }]}
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
  );
  const sections = (<>
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

      {proposal && proposalLabels ? (
        <ItemGroup title={proposalLabels.title}>
          <ResourceProposalBody controller={proposal} decisionsAvailable={!approvalRouteUnavailable}
            arrive={false} onApproveKeepingUndo={() => { void decide('approve', { keepUndo: true }); }}
            testID="approvals.resource-proposal" />
        </ItemGroup>
      ) : projectCommand ? (
        <ItemGroup title={t('approvals.details')}>
          <SectionContentRow>
            <ProjectCommandApprovalFacts presentation={projectCommand} testID="approvals.project-command" />
          </SectionContentRow>
        </ItemGroup>
      ) : shownActionFields && !confidentialAction ? (
        <ActionApprovalFieldsCard presentation={shownActionFields} anatomy="page" serverId={approvalServerId}
          homeIdentity={approvalHomeKnown ? undefined : approvalOriginHomeId || undefined}
          failureCode={failureCodeInDetails ? executionFailure?.code ?? undefined : undefined} />
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

  </>);
  const workspaceSyncReview = approvedWorkspaceSyncResolution ? (
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
      ) : null;
  const requesterContext = (<ApprovalSessionContextCard
        session={session}
        sessionName={requesterName}
        machine={machine}
        serverId={approvalServerId}
        context={sessionContext}
        contextFacts={sessionContextFacts}
        homeName={approvalHomeName}
        // A Home this device knows but that has no name is "This Home", never its address. A Home it does
        // not know (or can no longer route to) cannot be named, so its exact identity waits in Technical details.
        homeDisplayId={approvalHomeKnown ? t('settingsAccount.thisHomeTitle') : null}
        requesterSessionId={sessionId}
        requesterStatus={requesterStatus}
        requesterAgentId={parsed.request.createdBy.agentId ?? null}
        requesterSurface={requesterSurface}
      />);
  const requesterConfirmationSection = requesterConfirmation ? (
        <ApprovalRequesterConfirmationSection
          subject={requesterConfirmation}
      serverId={approvalServerId}
          open={parsed.request.status === 'open' && !answeredWhileOpen}
          operationCredentialUses={requesterOperationCredentialUses}
          decision={parsed.request.decision
            ? { kind: parsed.request.decision.kind, decidingAccountId: 'decidingAccountId' in parsed.request.decision
              && typeof parsed.request.decision.decidingAccountId === 'string' ? parsed.request.decision.decidingAccountId : undefined }
            : null}
        />
      ) : null;
  const confidential = confidentialPrompt ? <ConfidentialSecretApproval key={confidentialReviewKey} artifactId={props.artifactId}
        approval={confidentialPrompt} serverId={approvalServerId} isOpen={parsed.request.status === 'open' && !answeredWhileOpen}
        unavailable={approvalRouteUnavailable} isDeciding={isDeciding} onDecision={decide} /> : null;
  const capabilityDecisions = capabilityEnable && parsed.kind === 'built_in' && artifact && sessionId ? (
        <ItemGroup surface="none">
          <CapabilityEnableDetailsDecisions artifact={artifact} approval={parsed.request} sessionId={sessionId}
            serverId={approvalServerId ?? null} disabled={isDeciding || approvalRouteUnavailable}
            onDismiss={() => { void decide('cancel'); }} />
        </ItemGroup> ) : null;
  const decisionBar = parsed.request.status === 'open' && !answeredWhileOpen && !confidentialApproval && !confidentialInputs
        && (!requesterConfirmation || requesterMayDecide) ? (
<ApprovalDecisionBar testID="approvals.actions" busy={isDeciding && !homeUnavailable}
            irreversible={review?.irreversible === true && !secretPrompt}
            layout={handoffTargetPresentation ? 'stacked' : 'inline'}
            approve={!secretPrompt ? {
              testID: 'approvals.approve', label: handoffTargetPresentation?.decisionLabel ?? projectCommandDecisions?.approve ?? proposalLabels?.approve
                ?? discussionDraftDecisions?.approve ?? review?.approveVerb ?? undefined,
              disabled: isDeciding || approvalWithheld || approvalRouteUnavailable || Boolean(proposal?.approveWithheld),
              accessibilityHint: approvalRouteUnavailable ? t('actionConfirmations.homeUnavailable')
                : approvalWithheld ? t('approvals.approveUnavailableHint') : undefined,
              onPress: () => decide('approve'),
            } : undefined}
            dismiss={projectCommand ? undefined : { testID: 'approvals.cancel', disabled: isDeciding, accessibilityHint: t('approvals.dismissHint'),
              onPress: () => decide('cancel') }}
            reject={{ testID: 'approvals.reject', label: projectCommandDecisions?.reject ?? proposalLabels?.reject ?? discussionDraftDecisions?.reject, disabled: isDeciding || approvalRouteUnavailable,
              accessibilityHint: approvalRouteUnavailable ? t('actionConfirmations.homeUnavailable') : undefined,
              onPress: () => decide('reject') }} />
  ) : null;
  const decision = capabilityDecisions ?? (decisionBar ? <ItemGroup surface="none">{decisionBar}</ItemGroup> : null);
  return {
    kind: 'ready' as const,
    title: projectCommandTitle ?? (requestTitle.title || t('approvals.untitled')),
    description: parsed.kind === 'target' && parsed.request.detail ? parsed.request.detail : requestTitle.detail ?? undefined,
    headerFacts,
    open: parsed.request.status === 'open' && !answeredWhileOpen,
    requestNotice: Boolean(executionFailure || approvalRouteUnavailable),
    requestGroup, sections, decision, decisionBar, capabilityDecisions,
    workspaceSyncReview, requesterContext, requesterConfirmationSection, confidential,
  };
}
