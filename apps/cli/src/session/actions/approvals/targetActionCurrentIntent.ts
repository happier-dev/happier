import { PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE, PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import { TargetActionApprovalRequestV1Schema, StoredTargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { PluginLocalizedStringV2, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import { createLiveApprovalDecision } from './liveDecision';
import { targetActionApprovalSubjectsEqual } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { projectTargetActionApprovalInput, resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { admitApprovalRequesterDecisionV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { projectTargetActionApprovalInvocationV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { createCliApprovalsArtifactStore } from './artifactStore';
import { buildTargetActionApprovalDecisionResult } from '@happier-dev/protocol/actions/targetActionApprovalDecision';

function resolveLocalizedConfirmationText(value: PluginLocalizedStringV2): string {
  return typeof value === 'string' ? value : value.fallback;
}

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

/**
 * Rebuilds the persisted approval subject from the current canonical Action
 * owner. The durable placement is supplied only after exact-daemon re-entry,
 * so stale source custody, policy, input, presentation, or placement refuses
 * before the target handler begins.
 */
export function targetActionApprovalMatchesCurrentIntent(
  request: TargetActionApprovalRequestV1,
  currentIntent: TargetActionCurrentIntentRequest,
): boolean {
  const candidate = createTargetActionApprovalRequestCandidate(currentIntent, {
    createdAtMs: request.createdAtMs,
    updatedAtMs: request.updatedAtMs,
  });
  return candidate !== null
    && candidate.subjectFingerprint === request.subjectFingerprint
    && targetActionApprovalSubjectsEqual(candidate, request);
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
    const liveDecision = createLiveApprovalDecision({ read: deps.read, signal, subscribeChanges });
    let created: Awaited<ReturnType<typeof deps.create>>;
    try { created = await deps.create(proposedRequest, ready => {
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
    const result = await liveDecision.waitForDecision({ artifactId, request });
    const decidedRequest = StoredTargetActionApprovalRequestV1Schema.safeParse(result.request);
    if (!decidedRequest.success
      || decidedRequest.data.subjectFingerprint !== fingerprint
      || !targetActionApprovalSubjectsEqual(request, decidedRequest.data)) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' };
    }
    if (result.decision === 'approve') {
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
    }
    return result.decision === 'approve'
      ? { status: 'approved', fingerprint, artifactId,
          settleExecution: async ({ artifactId: admittedArtifactId, execution }) => {
            if (admittedArtifactId !== artifactId || !update) throw new Error('approval_stale');
            const latest = await deps.read(artifactId);
            if (!latest || latest.approvalInputCustody !== 'live_only'
              || latest.status !== 'executing' || latest.decision?.kind !== 'approve'
              || !targetActionApprovalSubjectsEqual(request, latest)) throw new Error('approval_stale');
            const executedAtMs = Math.max((deps.now ?? Date.now)(), latest.updatedAtMs);
            const terminal = TargetActionApprovalRequestV1Schema.parse({ ...latest,
              status: execution.ok ? 'executed' : 'failed', updatedAtMs: executedAtMs,
              execution: { ...execution, executedAtMs,
                ...(execution.errorCode === PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
                  ? { errorCode: 'approval_execution_outcome_unknown' } : {}),
              },
            });
            const updated = await update({ artifactId, request: terminal });
            if (!updated.ok) throw new Error(updated.errorCode);
          },
          ...(request.requesterConfirmation ? { revalidateRequesterDecision: async () => {
            const invocation = projectTargetActionApprovalInvocationV1(request);
            return invocation !== null && (await admitApprovalRequesterDecisionV1({
              request: { ...request, ...invocation },
              context: { authority: 'present_user', surface: 'ui', runtimeAccountId: request.requesterConfirmation!.executionAccountId,
                requesterApprovalDecision: result.requesterApprovalDecision },
            })).ok;
          } } : {}),
        }
      : { status: 'rejected', code: PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE };
  };
}
