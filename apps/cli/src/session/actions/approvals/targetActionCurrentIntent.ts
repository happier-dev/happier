import {
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

export function createTargetActionCurrentIntentAdapter(deps: Readonly<{
  create: (request: TargetActionApprovalRequestV1) => Promise<Readonly<{ artifactId: string }>>;
  read: (artifactId: string) => Promise<TargetActionApprovalRequestV1 | null>;
  now?: () => number;
}>): (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  return async ({ action, fingerprint, surface, invocationSurface, signal }) => {
    if (!action.confirmation) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    }
    const requestedSurface = invocationSurface ?? surface;
    const now = (deps.now ?? Date.now)();
    const candidate = {
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: now, updatedAtMs: now,
      createdBy: { surface: requestedSurface === 'agent' || requestedSurface === 'mcp' || requestedSurface === 'cli' ? requestedSurface : 'system' },
      requestedSurface, qualifiedActionId: action.qualifiedId, input: action.input,
      ...(action.accountId ? { accountId: action.accountId } : {}), ...(action.resourceId ? { resourceId: action.resourceId } : {}),
      generation: action.generation, policyFingerprint: action.policyFingerprint,
      subjectFingerprint: fingerprint,
      summary: resolveLocalizedConfirmationText(action.confirmation.title),
      ...(action.confirmation.body
        ? { detail: resolveLocalizedConfirmationText(action.confirmation.body) }
        : {}),
    } as const;
    const parsedRequest = TargetActionApprovalRequestV1Schema.safeParse(candidate);
    if (!parsedRequest.success) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_unavailable' };
    }
    const request = parsedRequest.data;
    const created = await deps.create(request);
    const result = await coordinator.waitForDecision({ artifactId: created.artifactId, request, signal, readRequest: () => deps.read(created.artifactId) });
    const decidedRequest = TargetActionApprovalRequestV1Schema.safeParse(result.request);
    if (!decidedRequest.success
      || decidedRequest.data.subjectFingerprint !== fingerprint
      || !targetActionApprovalSubjectsEqual(request, decidedRequest.data)) {
      return { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' };
    }
    return result.decision === 'approve'
      ? { status: 'approved', fingerprint }
      : { status: 'rejected', code: 'plugin_action_current_intent_rejected' };
  };
}
