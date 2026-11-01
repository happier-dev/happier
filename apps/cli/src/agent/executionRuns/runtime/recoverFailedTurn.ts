import { resolveSessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { resolveRecoverableTurnFailureRetryDecision } from '@/agent/runtime/session/recoverableTurnFailurePolicy';
import { buildContinuationResumePrompt } from '@/daemon/connectedServices/continuation/continuationResumePrompt';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY, readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { ExecutionRunConnectedServiceRegistrationV1 } from '@/daemon/connectedServices/runsBridge/contract';
import { decideConnectedServiceRecovery } from '@/daemon/connectedServices/runtimeAuth/ConnectedServiceRecoveryPolicy';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { resolveRuntimeAuthRecoveryResultDisposition } from '@/daemon/connectedServices/runtimeAuth/resolveRuntimeAuthRecoveryResultDisposition';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { computeCapacityBackoffMs } from '@/daemon/connectedServices/temporaryThrottle/capacityBackoff';
import type { ExecutionRunState } from './executionRunTypes';
import { delayUnrefAbortable } from '@/utils/time';

export type ExecutionRunRecoveryContext = Readonly<{
  resolveAccountSettings?: () => Promise<Readonly<Record<string, unknown>> | null> | Readonly<Record<string, unknown>> | null;
  runs?: Map<string, ExecutionRunState>;
  onPublicStateUpdated?: (runId: string) => void;
  writeActivityMarker?: (runId: string, nowMs: number, opts: Readonly<{ force: boolean }>) => Promise<void>;
}>;

export function readExecutionRunFailureClassification(error: unknown) {
  return error && typeof error === 'object' && 'runtimeAuthClassification' in error
    ? sanitizeConnectedServiceRuntimeFailureClassification(error.runtimeAuthClassification)
    : null;
}

async function waitForRetry(controller: ExecutionRunBackendController, delayMs: number): Promise<boolean> {
  const abort = new AbortController();
  controller.recoveryAbortController = abort;
  try {
    if (controller.cancelled || controller.disposalPromise) return false;
    await delayUnrefAbortable(delayMs, abort.signal);
    return !abort.signal.aborted;
  } finally {
    if (controller.recoveryAbortController === abort) controller.recoveryAbortController = undefined;
  }
}

/** Consumes provider classification and shared recovery decisions; never selects or applies an account. */
export async function recoverFailedExecutionRunTurn(args: ExecutionRunRecoveryContext & Readonly<{
  runId: string;
  controller: ExecutionRunBackendController;
  error: unknown;
  originalPrompt: string;
  attemptCount: number;
  isCurrentTurn?: () => boolean;
  getNowMs: () => number;
  registration?: ExecutionRunConnectedServiceRegistrationV1 | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  announceWaiting: (message: string) => void;
}>): Promise<string | null> {
  const raw = readExecutionRunFailureClassification(args.error);
  const isCurrent = () => !args.controller.cancelled
    && !args.controller.disposalPromise
    && !(args.controller.turnCancelReason === 'outcome_unknown' && args.controller.turnCancelEpoch === args.controller.turnEpoch)
    && (args.isCurrentTurn?.() ?? true);
  if (!raw || !isCurrent()) return null;
  const registration = args.runs?.get(args.runId)?.launch?.connectedServicesRegistration ?? args.registration;
  const selection = registration?.connectedServiceSelectionsJson
    ? readConnectedServiceChildSelectionsFromEnv({
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: registration.connectedServiceSelectionsJson,
      }).find((candidate) => candidate.serviceId === raw.serviceId) ?? null
    : null;
  const profileId = selection?.kind === 'group' ? selection.activeProfileId : selection?.profileId;
  // Missing provider attribution is filled from this run's proven materialization, never the parent.
  const issue = {
    ...raw,
    profileId: raw.profileId ?? profileId ?? null,
    groupId: raw.groupId ?? (selection?.kind === 'group' ? selection.groupId : null),
    ...(selection ? { credentialRevision: raw.credentialRevision ?? selection.credentialRevision } : {}),
    ...(selection?.kind === 'group' ? { groupGeneration: raw.groupGeneration ?? selection.generation } : {}),
  };
  const settings = await args.resolveAccountSettings?.() ?? args.accountSettings ?? null;
  if (!isCurrent()) return null;
  let resumePromptMode = resolveSessionUsageLimitRecoveryResumePromptModeV1({ accountSettings: settings });
  const policy = decideConnectedServiceRecovery({ actor: 'automatic', issue, selection });
  let retryAtMs: number | null = null;
  if (policy.action === 'temporary_retry') {
    retryAtMs = Math.max(
      args.getNowMs() + computeCapacityBackoffMs(args.attemptCount + 1),
      args.getNowMs() + (policy.retryAfterMs ?? 0),
      policy.resetAtMs ?? 0,
    );
  } else if (registration) {
    const report = await reportConnectedServiceRuntimeAuthFailureToDaemon({
      sessionId: registration.materializationKey,
      delivery: 'caller_owned',
      classification: issue,
      logPrefix: '[EXECUTION RUN]',
    });
    if (!isCurrent()) return null;
    resumePromptMode = report.resumePromptMode ?? resumePromptMode;
    const envelope = report.report && typeof report.report === 'object' && 'result' in report.report
      ? report.report.result : report.report;
    const disposition = resolveRuntimeAuthRecoveryResultDisposition({
      result: envelope, classificationResetsAtMs: issue.resetsAtMs,
      classificationFailureKind: issue.kind, nowMs: args.getNowMs(),
    });
    if (disposition?.kind === 'durable_wait') retryAtMs = disposition.nextRetryAtMs;
    // A selected new member is available to a later resume. Applying it to this live backend is step 3.
  }
  if (retryAtMs === null || !isCurrent()) return null;
  const nested = settings?.usageLimitRecoverySettingsV1;
  const customResumePrompt = nested && typeof nested === 'object' && 'customResumePrompt' in nested
    && typeof nested.customResumePrompt === 'string' ? nested.customResumePrompt : null;
  const decision = resolveRecoverableTurnFailureRetryDecision({
    attemptCount: args.attemptCount, maxRetries: null,
    failedTurnHadMeaningfulActivity: args.controller.turnHadMeaningfulActivity === true,
    promptMode: resumePromptMode === 'off' ? 'off' : 'activity_aware',
    originalPrompt: args.originalPrompt,
    continuationPrompt: buildContinuationResumePrompt({ resumePromptMode, customResumePrompt, recoveryKind: issue.kind }),
  });
  if (decision.action !== 'retry') return null;
  const message = `Waiting for the provider to become available. Retrying at ${new Date(retryAtMs).toISOString()}.`;
  const publish = (waiting: boolean) => {
    const run = args.runs?.get(args.runId);
    if (run?.status === 'running') {
      args.runs?.set(args.runId, {
        ...run, error: waiting ? { code: `execution_run_recovering_${issue.kind}`, message } : undefined,
      });
      args.onPublicStateUpdated?.(args.runId);
      void args.writeActivityMarker?.(args.runId, args.getNowMs(), { force: true });
    }
  };
  publish(true);
  args.announceWaiting(message);
  const ready = await waitForRetry(args.controller, Math.max(0, retryAtMs - args.getNowMs()));
  if (!ready || !isCurrent()) return null;
  publish(false);
  return decision.prompt;
}
