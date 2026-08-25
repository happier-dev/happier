import {
  PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE,
  TargetActionApprovalRequestV1Schema,
  type PluginLocalizedStringV2,
  type TargetActionApprovalRequestV1,
} from '@happier-dev/protocol';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import { getSharedBlockingApprovalCoordinator } from './blockingApprovalCoordinator';
import { targetActionApprovalSubjectsEqual } from './targetActionApprovalSubject';

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
  } = currentIntent;
  const requestedSurface = invocationSurface ?? surface;
  const approvalRequiredByActionSettings = action.approvalRequiredByActionSettings === true;
  if (!action.confirmation && !approvalRequiredByActionSettings) return null;
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
    input: action.input,
    ...(action.accountId ? { accountId: action.accountId } : {}),
    ...(action.resourceId ? { resourceId: action.resourceId } : {}),
    generation: action.generation,
    policyFingerprint: action.policyFingerprint,
    subjectFingerprint: fingerprint,
    ...(replayPlacement === undefined ? {} : { replayPlacement }),
    summary: action.confirmation
      ? resolveLocalizedConfirmationText(action.confirmation.title)
      : 'Action approval required',
    ...(action.confirmation?.body
      ? { detail: resolveLocalizedConfirmationText(action.confirmation.body) }
      : {}),
  } as const;
  const parsed = TargetActionApprovalRequestV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Rebuilds the persisted approval subject from the current canonical Action
 * owner. The durable placement is supplied only after exact-daemon re-entry,
 * so a stale generation, policy, input, presentation, or placement refuses
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
  create: (request: TargetActionApprovalRequestV1) => Promise<Readonly<{ artifactId: string }>>;
  read: (artifactId: string) => Promise<TargetActionApprovalRequestV1 | null>;
  now?: () => number;
}>): (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  return async (currentIntent) => {
    const { fingerprint, surface, invocationSurface, signal } = currentIntent;
    const requestedSurface = invocationSurface ?? surface;
    const now = (deps.now ?? Date.now)();
    const request = createTargetActionApprovalRequestCandidate(currentIntent, {
      createdAtMs: now,
      updatedAtMs: now,
    });
    if (request === null) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    }
    const created = await deps.create(request);
    const artifactId = created.artifactId.trim();
    if (!artifactId) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    }
    if (requestedSurface === 'api') {
      return { status: 'deferred', artifactId };
    }
    const result = await coordinator.waitForDecision({ artifactId, request, signal, readRequest: () => deps.read(artifactId) });
    const decidedRequest = TargetActionApprovalRequestV1Schema.safeParse(result.request);
    if (!decidedRequest.success
      || decidedRequest.data.subjectFingerprint !== fingerprint
      || !targetActionApprovalSubjectsEqual(request, decidedRequest.data)) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' };
    }
    return result.decision === 'approve'
      ? { status: 'approved', fingerprint }
      : { status: 'rejected', code: PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE };
  };
}
