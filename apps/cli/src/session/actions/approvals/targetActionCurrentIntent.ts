import { PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE, PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import { TargetActionApprovalRequestV1Schema, StoredTargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { resolvePluginLocalizedStringV2Text as resolveLocalizedConfirmationText } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import { createLiveApprovalDecision } from './liveDecision';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { settleTargetActionApprovalReplayInputs } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { projectTargetActionApprovalInput, resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { createCliApprovalsArtifactStore } from './artifactStore';
import { persistTargetActionReceipt } from './targetActionSettlement';
import { buildTargetActionApprovalDecisionResult } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { traceExternalActionInnerStage } from '@/daemon/externalActions/externalActionPhase';

function createTargetActionApprovalRequestCandidate(
  currentIntent: TargetActionCurrentIntentRequest,
  timestamps: Readonly<{ createdAtMs: number; updatedAtMs: number }>,
): TargetActionApprovalRequestV1 | null {
  const {
    action,
    fingerprint,
    surface,
    invocationSurface,
    replayPlacement,
    executionOriginV1,
    requesterConfirmation,
  } = currentIntent;
  const requestedSurface = invocationSurface ?? surface;
  const approvalRequiredByActionSettings = action.approvalRequiredByActionSettings === true;
  if (!action.confirmation && !approvalRequiredByActionSettings) {
    currentIntent.reportUnavailable?.('approval_not_required');
    return null;
  }
  const projected = projectTargetActionApprovalInput(action.input, action.secretInputPaths ?? []);
  if (!projected) {
    currentIntent.reportUnavailable?.('approval_input_unrepresentable');
    return null;
  }
  const candidate = {
    v: 1,
    kind: 'plugin_target_action',
    status: 'open',
    createdAtMs: timestamps.createdAtMs,
    updatedAtMs: timestamps.updatedAtMs,
    createdBy: {
      surface: requestedSurface === 'agent'
        || requestedSurface === 'mcp'
        || requestedSurface === 'cli'
        ? requestedSurface
        : 'system',
    },
    requestedSurface,
    qualifiedActionId: action.qualifiedId,
    input: projected.input,
    secretInputPaths: action.secretInputPaths ?? [],
    ...(action.secretInputLabels === undefined ? {} : { secretInputLabels: action.secretInputLabels }),
    ...(action.confirmation?.inputFields === undefined ? {} : { inputFields: action.confirmation.inputFields }),
    ...(currentIntent.approvalInputCustody === 'live_only' || projected.confidentialPaths.length || requesterConfirmation && requestedSurface === 'plugin'
      ? { approvalInputCustody: 'live_only' } : {}),
    ...(action.accountId ? { accountId: action.accountId } : {}),
    ...(action.resourceId ? { resourceId: action.resourceId } : {}),
    sourceCustody: action.sourceCustody,
    policyFingerprint: action.policyFingerprint,
    subjectFingerprint: fingerprint,
    ...(replayPlacement === undefined ? {} : { replayPlacement }),
    ...(executionOriginV1 === undefined ? {} : { executionOriginV1 }),
    ...(requesterConfirmation === undefined ? {} : { requesterConfirmation }),
    summary: action.confirmation
      ? resolveLocalizedConfirmationText(action.confirmation.title)
      : 'Action approval required',
    ...(action.confirmation?.body
      ? { detail: resolveLocalizedConfirmationText(action.confirmation.body) }
      : {}),
  } as const;
  const parsed = TargetActionApprovalRequestV1Schema.safeParse(candidate);
  if (!parsed.success) {
    currentIntent.reportUnavailable?.('approval_subject_invalid');
    return null;
  }
  if (resolveApprovalRequestApproveAdmission(parsed.data).status !== 'available') {
    currentIntent.reportUnavailable?.('approval_presentation_unavailable');
    return null;
  }
  return parsed.data;
}

export function createTargetActionCurrentIntentAdapter(deps: Readonly<{
  create: (request: TargetActionApprovalRequestV1,
    onReady?: (created: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>) => void,
  ) => Promise<Readonly<{ artifactId: string; request?: TargetActionApprovalRequestV1 }>>;
  read: (artifactId: string) => Promise<TargetActionApprovalRequestV1 | null>;
  update?: ReturnType<typeof createCliApprovalsArtifactStore>['targetActionApprovalsUpdate'];
  subscribeChanges?: (
    artifactId: string,
    onChange: () => void,
    onError: (error: unknown) => void,
  ) => Readonly<{ dispose(): void | Promise<void> }>;
  now?: () => number;
}>): (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> {
  const subscribeChanges = deps.subscribeChanges;
  return async (currentIntent) => {
    const { fingerprint, signal } = currentIntent;
    const now = (deps.now ?? Date.now)();
    const proposedRequest = createTargetActionApprovalRequestCandidate(currentIntent, {
      createdAtMs: now,
      updatedAtMs: now,
    });
    if (proposedRequest === null) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    }
    const update = deps.update;
    // A durable request has its existing replay writer. Live-only operands
    // instead require the incumbent's receipt port before creating consent.
    if (proposedRequest.approvalInputCustody === 'live_only' && !update) {
      currentIntent.reportUnavailable?.('approval_factory_unavailable');
      return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    }
    const liveDecision = createLiveApprovalDecision({ read: async artifactId => {
      const request = await deps.read(artifactId);
      traceExternalActionInnerStage('contributed.target_invoke.approval', { artifactId, approvalStatus: request?.status ?? null });
      return request;
    }, signal, subscribeChanges });
    let created: Awaited<ReturnType<typeof deps.create>>;
    try { created = await deps.create(proposedRequest, ready => {
      traceExternalActionInnerStage('contributed.target_invoke.approval', { artifactId: ready.artifactId, approvalStatus: ready.request.status });
      if (ready.request.approvalInputCustody === 'live_only') void liveDecision.waitForDecision(ready);
    }); }
    catch (error) {
      await liveDecision.cancelCreation();
      currentIntent.reportUnavailable?.('approval_artifact_create_failed');
      throw error;
    }
    const artifactId = created.artifactId.trim();
    const request = created.request ?? proposedRequest;
    if (!artifactId) {
      await liveDecision.cancelCreation();
      currentIntent.reportUnavailable?.('approval_artifact_id_unavailable');
      return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    }
    if (request.approvalInputCustody !== 'live_only') {
      await liveDecision.cancelCreation();
      return { status: 'deferred', artifactId };
    }
    currentIntent.onLiveApprovalRequested?.(artifactId);
    const result = await liveDecision.waitForDecision({ artifactId, request });
    const decidedRequest = StoredTargetActionApprovalRequestV1Schema.safeParse(result.request);
    if (!decidedRequest.success
      || decidedRequest.data.subjectFingerprint !== fingerprint
      || decidedRequest.data.qualifiedActionId !== request.qualifiedActionId
      || decidedRequest.data.accountId !== request.accountId
      || decidedRequest.data.executionOriginV1?.accountId !== request.executionOriginV1?.accountId
      || !sameStrictJsonValue(settleTargetActionApprovalReplayInputs(decidedRequest.data).input,
        settleTargetActionApprovalReplayInputs(request, decidedRequest.data.status).input)) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_mismatch', mismatch: { field: 'fingerprint_source' } };
    }
    if (result.decision !== 'approve') {
      return { status: 'rejected', code: PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE };
    }
    // A recorded approval decision is history once its effect has settled.
    // Rejoining that receipt must not claim or execute the same intent again.
    if (decidedRequest.data.status !== 'approved') {
      const terminal = buildTargetActionApprovalDecisionResult(decidedRequest.data);
      return terminal.ok ? { status: 'deferred', artifactId } : { status: 'unavailable', code: terminal.errorCode };
    }
    if (!update) return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    const executionClaim = TargetActionApprovalRequestV1Schema.parse({ ...decidedRequest.data,
      status: 'executing', updatedAtMs: Math.max((deps.now ?? Date.now)(), decidedRequest.data.updatedAtMs),
    });
    const claimed = await update({ artifactId, request: executionClaim });
    if (!claimed.ok) return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    return { status: 'approved', fingerprint, artifactId,
      settleExecution: async ({ artifactId: admittedArtifactId, execution }) => {
        if (admittedArtifactId !== artifactId || !update) throw new Error('approval_stale');
        const executedAtMs = Math.max((deps.now ?? Date.now)(), executionClaim.updatedAtMs);
        const terminal = TargetActionApprovalRequestV1Schema.parse({ ...executionClaim,
          status: execution.ok ? 'executed' : 'failed', updatedAtMs: executedAtMs,
          execution: { ...execution, executedAtMs,
            ...(execution.errorCode === PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
              ? { errorCode: 'approval_execution_outcome_unknown' } : {}),
          },
        });
        const settled = await persistTargetActionReceipt({ request: terminal,
          write: async request => (await update({ artifactId, request })).ok });
        if (!settled) throw new Error('approval_execution_outcome_unknown');
      },
    };
  };
}
