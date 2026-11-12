import * as React from 'react';
import type { DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { readDeploymentTemplateInstantiationPartialV1 as readDeploymentPartialResult } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
export { readDeploymentPartialResult };
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';
import type { DeploymentPreviewEnrollmentV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { HappyError } from '@/utils/errors/errors';

import { readActionApprovalRequestCreatedError } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** Where a recovery destination opens: a build Machine's setup, or the failed deployment's own receipt for its logs. */
export type DeploymentRecoveryTarget = Readonly<{ machineId?: string; deploymentId?: string }>;

type DeploymentPressReview = Readonly<{
  request: (artifactId: string) => void;
  pendingId?: string | null;
  open?: () => void;
  openRecovery?: (destination: DeploymentFailureRecoveryDestinationV1, at?: DeploymentRecoveryTarget) => void;
}>;

export type DeploymentOutcomeController = Readonly<{
  outcome: DeploymentActionOutcome | null;
  pending: boolean;
  openReview: (() => void) | null;
  retry: () => Promise<void>;
  openRecovery: ((destination: DeploymentFailureRecoveryDestinationV1, at?: DeploymentRecoveryTarget) => void) | null;
}>;

function createDeploymentOutcomeController(outcome: DeploymentActionOutcome | null, review: DeploymentPressReview | null,
  retry: () => Promise<void>): DeploymentOutcomeController {
  return { outcome, pending: outcome?.kind === 'approval' && review?.pendingId === outcome.artifactId,
    openReview: review?.open ?? null, retry, openRecovery: review?.openRecovery ?? null };
}

/**
 * What a Deploy or Roll back press led to, for the page that pressed it. The Action owner decides; this only
 * reads its answer: a new receipt to open, a review the person still has to approve, accepted work that will
 * appear in the rail, or a typed refusal. Nothing here retries.
 */
export type DeploymentActionOutcome =
  | Readonly<{ kind: 'receipt'; deploymentId: string }>
  | Readonly<{ kind: 'approval'; artifactId: string }>
  | Readonly<{ kind: 'started' }>
  | Readonly<{
      kind: 'refused';
      reason: DeploymentRefusalReason;
      code: string;
      progress?: DeploymentPartialResult;
      failure?: ActionExecuteFailure;
    }>;

export type DeploymentPartialResult = NonNullable<ReturnType<typeof readDeploymentPartialResult>>;

/** The failed step opens its existing editor; its completed steps are never replayed here. */
export function deploymentPartialRecoveryTab(progress: DeploymentPartialResult): DeploymentEnvironmentTabV1 {
  switch (progress.phase) {
    case 'generation':
    case 'bindings': return 'variables';
    case 'domains': return 'domains';
    case 'target': {
      const input = progress.continuation?.input;
      return input && 'role' in input && input.role === 'data' ? 'overview' : 'settings';
    }
    case 'metadata': return 'settings';
    case 'environment':
    case 'repository':
    case 'deploy': return 'overview';
  }
}

/** The refusals a person can act on differently; everything else says what was refused by its code. */
export type DeploymentRefusalReason =
  | 'repository'
  | 'permission'
  | 'machine'
  | 'unsupported'
  | 'other';

type ReceiptResult =
  | Readonly<{ ok: true; deploymentId?: string }>
  | Readonly<{ ok: false; error: string; deploymentId?: string; details?: unknown;
      failureCause?: ActionExecuteFailure['failureCause']; effectAttempted?: boolean }>;

/** A typed refusal code and the way a person can act on it; the one classifier for every deployment press. */
export function readDeploymentRefusal(code: string): Extract<DeploymentActionOutcome, { kind: 'refused' }> {
  const reason: DeploymentRefusalReason =
    code === 'repository_required'
      ? 'repository'
      : code === 'deployment_access_denied' || code === 'action_not_allowed'
        ? 'permission'
        : code === 'machine_unavailable'
          ? 'machine'
          : code === 'unsupported' || code === 'unsupported_action'
            ? 'unsupported'
            : 'other';
  return { kind: 'refused', reason, code };
}

export function readDeploymentActionResult(
  result: ReceiptResult,
  inProgress: 'receipt' | 'refused' = 'receipt',
): DeploymentActionOutcome {
  if (result.ok)
    return typeof result.deploymentId === 'string'
      ? { kind: 'receipt', deploymentId: result.deploymentId }
      : { kind: 'started' };
  const failure: ActionExecuteFailure = { ok: false, error: result.error, errorCode: result.error,
    details: result.details, failureCause: result.failureCause, effectAttempted: result.effectAttempted };
  // Deploy follows existing work; disposition must explain why nothing was removed.
  if (result.error === 'deployment_in_progress' && result.deploymentId) {
    if (inProgress === 'receipt') return { kind: 'receipt', deploymentId: result.deploymentId };
    return { ...readDeploymentRefusal(result.error), failure: { ...failure, details: result.details ?? result } };
  }
  const progress = readDeploymentPartialResult(failure);
  return { ...readDeploymentRefusal(result.error), ...(progress ? { progress } : {}),
    ...(result.details !== undefined || result.failureCause !== undefined || result.effectAttempted !== undefined ? { failure } : {}) };
}

export function readDeploymentActionError(
  error: unknown,
): DeploymentActionOutcome {
  const approval = readActionApprovalRequestCreatedError(error);
  if (approval) return { kind: 'approval', artifactId: approval.artifactId };
  const code = (error as { code?: unknown } | null)?.code;
  const failure: ActionExecuteFailure = { ok: false, errorCode: typeof code === 'string' && code ? code : 'unknown_error',
    error: error instanceof Error ? error.message : typeof code === 'string' ? code : 'unknown_error',
    ...(error instanceof HappyError ? { details: error.details, failureCause: error.failureCause, effectAttempted: error.effectAttempted,
      ...(error.requestId ? { requestId: error.requestId } : {}) } : {}) };
  const progress = readDeploymentPartialResult(failure);
  return { ...readDeploymentRefusal(failure.errorCode), ...(progress ? { progress } : {}),
    ...(progress || failure.details !== undefined || failure.failureCause !== undefined || failure.effectAttempted !== undefined ? { failure } : {}) };
}

/** Run one press through the Action owner and read its answer. */
export async function runDeploymentAction(
  press: () => Promise<ReceiptResult>,
): Promise<DeploymentActionOutcome> {
  try {
    return readDeploymentActionResult(await press());
  } catch (error) {
    return readDeploymentActionError(error);
  }
}

/**
 * One page control's press through the Action owner, as Deploy, Deploy again, Roll back and Cancel use it: one
 * press at a time, a new receipt opens (unless the press acts on the receipt already shown), a held review goes
 * to the page's approval continuation, and the answer stays for the banner where the person pressed.
 */
export function useDeploymentPress(
  review: DeploymentPressReview,
  onOpenReceipt: (deploymentId: string) => void,
) {
  const [running, setRunning] = React.useState(false);
  const [outcome, setOutcome] = React.useState<DeploymentActionOutcome | null>(null);
  const busy = React.useRef(false);
  const { request } = review;
  const lastPress = React.useRef<(() => Promise<ReceiptResult>) | null>(null);
  const lastOptions = React.useRef<Readonly<{ openReceipt?: boolean }> | undefined>(undefined);
  const press = React.useCallback(async (
    run: () => Promise<ReceiptResult>,
    options?: Readonly<{ openReceipt?: boolean }>,
  ) => {
    if (busy.current) return;
    lastPress.current = run;
    lastOptions.current = options;
    busy.current = true;
    setRunning(true);
    setOutcome(null);
    const result = await runDeploymentAction(run);
    busy.current = false;
    setRunning(false);
    if (result.kind === 'receipt' && options?.openReceipt !== false) {
      onOpenReceipt(result.deploymentId);
      return;
    }
    if (result.kind === 'approval') request(result.artifactId);
    setOutcome(result);
  }, [onOpenReceipt, request]);
  const retry = React.useCallback(async () => {
    if (lastPress.current) await press(lastPress.current, lastOptions.current);
  }, [press]);
  const banner = createDeploymentOutcomeController(outcome, review, retry);
  return { running, outcome, reviewPending: banner.pending, press, banner };
}

type SettledChange = Readonly<{ ok: true; previewEnrollment?: DeploymentPreviewEnrollmentV1 }> | Extract<ReceiptResult, { ok: false }>;

/**
 * One Environment change that settles in place (a Domain, the controller, who may deploy): no receipt to open. A held
 * review opens the page's approval; a refusal is kept for the banner; success re-reads what the change moved.
 */
export function useDeploymentChangePress(
  review: DeploymentPressReview | null,
  onSettled: () => void,
) {
  const [running, setRunning] = React.useState(false);
  const [outcome, setOutcome] = React.useState<DeploymentActionOutcome | null>(null);
  const [followup, setFollowup] = React.useState<Extract<DeploymentPreviewEnrollmentV1, { status: 'unavailable' }> | null>(null);
  const busy = React.useRef(false);
  const lastPress = React.useRef<(() => Promise<SettledChange>) | null>(null);
  // The page section whose control pressed, so its outcome shows where the person acted.
  const [outcomeAt, setOutcomeAt] = React.useState<string | null>(null);
  const lastAt = React.useRef<string | null>(null);
  const press = React.useCallback(async (run: () => Promise<SettledChange>, at?: string) => {
    if (busy.current) return false;
    lastPress.current = run;
    lastAt.current = at ?? null;
    setOutcomeAt(at ?? null);
    busy.current = true;
    setRunning(true);
    setOutcome(null);
    setFollowup(null);
    let next: DeploymentActionOutcome | null = null;
    try {
      const result = await run();
      if (!result.ok) next = readDeploymentActionResult(result);
      else if (result.previewEnrollment?.status === 'unavailable') setFollowup(result.previewEnrollment);
    } catch (error) {
      next = readDeploymentActionError(error);
      if (next.kind === 'approval') review?.request(next.artifactId);
    }
    busy.current = false;
    setRunning(false);
    setOutcome(next);
    if (next === null) onSettled();
    return next === null;
  }, [review, onSettled]);
  // A person can request a new review through the same Action entry point;
  // the refused approval itself is never replayed or accepted here.
  const retry = React.useCallback(async () => {
    if (lastPress.current) await press(lastPress.current, lastAt.current ?? undefined);
  }, [press]);
  const banner = createDeploymentOutcomeController(outcome, review, retry);
  return { running, outcome, outcomeAt, followup, press, retry, banner };
}
