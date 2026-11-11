import { randomUUID } from 'node:crypto';
import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import { buildActionExecuteResultFromRecordedApprovalExecution, type createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteResultSchema,
  type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestGetResultV1Schema, type ApprovalRequestPublicRead } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { isArtifactReadUnavailable, readRecordedApprovalDecision } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { observeAccountChanges } from '@/api/observeAccountChanges';

export type CliApprovalRequestedHandler = (artifactId: string, signal: AbortSignal,
  decide: (decision: 'approve' | 'reject') => Promise<ActionExecuteResult>) => void | ActionExecuteResult | Promise<void | ActionExecuteResult>;

/** Progress can prompt for Ask while the original transport retains private output. */
export async function executeLiveCliApprovalRequest<T extends ActionExecuteResult | null = ActionExecuteResult>(options: Readonly<{
  onApprovalRequested: CliApprovalRequestedHandler;
  execute: ReturnType<typeof createActionExecutor>['execute'];
  context: ActionExecutorContext;
  run(signal: AbortSignal, onApprovalRequested: (approval: ActionApprovalRequestCreatedResult) => void): Promise<T>;
}>): Promise<T | ActionExecuteResult> {
  const lifetime = new AbortController();
  const signal = options.context.signal ? AbortSignal.any([options.context.signal, lifetime.signal]) : lifetime.signal;
  let notification: Promise<void | ActionExecuteResult> | undefined;
  const notificationState: { failure?: { error: unknown } | { result: ActionExecuteResult } } = {};
  try {
    const result = await options.run(signal, approval => {
      notification ??= Promise.resolve().then(() => options.onApprovalRequested(approval.artifactId, signal,
        decision => options.execute('approval.request.decide', { artifactId: approval.artifactId, decision },
          { ...options.context, signal, actionRequestId: randomUUID() }))).then(result => {
        if (result && !result.ok) {
          notificationState.failure = { result };
          lifetime.abort();
        }
        return result;
      });
      void notification.catch(error => {
        notificationState.failure = { error };
        lifetime.abort(error);
      });
    });
    if (notificationState.failure) {
      if ('error' in notificationState.failure) throw notificationState.failure.error;
      return notificationState.failure.result;
    }
    return result;
  } finally {
    lifetime.abort();
    await notification?.catch(() => undefined);
  }
}

export function subscribeCliApprovalChanges(options: Readonly<{ token: string; serverHttpBaseUrl: string; artifactId: string }>) {
  return (onChange: () => void, onError: (error: unknown) => void) => observeAccountChanges({
    token: options.token, serverUrl: options.serverHttpBaseUrl, entityId: options.artifactId,
  }, { onChange, onError });
}

function readRecordedCliApprovalResult(request: ApprovalRequestPublicRead): ActionExecuteResult | null {
  const decision = readRecordedApprovalDecision(request);
  if (!decision) return null;
  if (decision.decision === 'approve') return buildActionExecuteResultFromRecordedApprovalExecution(decision.request);
  const errorCode = decision.decision === 'reject' ? 'approval_rejected' : 'approval_canceled';
  return { ok: false, errorCode, error: errorCode };
}

/** Consume the existing approval decision; the original Action is never submitted again. */
export async function consumeDeferredCliApprovalResult(result: ActionExecuteResult, options: Readonly<{
  onApprovalRequested?: CliApprovalRequestedHandler;
  execute: ReturnType<typeof createActionExecutor>['execute'];
  context?: ActionExecutorContext;
  token: string;
  serverHttpBaseUrl: string;
}>): Promise<ActionExecuteResult> {
  if (!result.ok || !options.onApprovalRequested) return result;
  const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
  if (!pending.success) return result;
  const lifetime = new AbortController();
  const signal = options.context?.signal ? AbortSignal.any([options.context.signal, lifetime.signal]) : lifetime.signal;
  const readReceipt = async () => {
    const observed = await options.execute('approval.request.get', { artifactId: pending.data.artifactId },
      { ...options.context, signal, actionRequestId: randomUUID() });
    if (!observed.ok) return observed;
    const receipt = ApprovalRequestGetResultV1Schema.safeParse(observed.result);
    return receipt.success ? { ok: true as const, request: receipt.data.request }
      : { ok: false as const, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
  };
  let subscription: ReturnType<ReturnType<typeof subscribeCliApprovalChanges>> | undefined;
  let stopped = false;
  let abortObservation: (() => void) | undefined;
  try {
    let localDecision: Promise<ActionExecuteResult> | undefined;
    const notification = Promise.resolve().then(() => options.onApprovalRequested!(pending.data.artifactId, signal, decision => {
      // The deciding call owns a live result. Its recorded observation can be
      // published before that call returns, and cannot replace its custody.
      localDecision = options.execute('approval.request.decide', { artifactId: pending.data.artifactId, decision },
        { ...options.context, signal, actionRequestId: randomUUID() });
      return localDecision;
    }));
    const observation = new Promise<ActionExecuteResult>((resolve, reject) => {
      let reading = false;
      let invalidated = false;
      const invalidate = () => {
        invalidated = true;
        if (reading || stopped) return;
        reading = true;
        void (async () => {
          try {
            while (invalidated && !stopped) {
              invalidated = false;
              let receipt: Awaited<ReturnType<typeof readReceipt>>;
              try { receipt = await readReceipt(); }
              catch (error) {
                if (isArtifactReadUnavailable(error)) continue;
                throw error;
              }
              if (stopped) return;
              // The prompt, cancellation and next push retain this wait. A
              // failed projection neither approves nor settles the Action.
              if (!receipt.ok) {
                if (isArtifactReadUnavailable(receipt)) continue;
                resolve(receipt); return;
              }
              const execution = readRecordedCliApprovalResult(receipt.request);
              if (execution) { resolve(execution); return; }
            }
          } finally {
            reading = false;
          }
        })().catch(reject);
      };
      abortObservation = () => reject(signal.reason ?? new Error('approval_wait_aborted'));
      signal.addEventListener('abort', abortObservation, { once: true });
      if (signal.aborted) { abortObservation(); return; }
      // Observe receipts only. Registering a live decision waiter here would
      // claim the daemon's approved execution instead of collecting its result.
      subscription = subscribeCliApprovalChanges({ token: options.token,
        serverHttpBaseUrl: options.serverHttpBaseUrl, artifactId: pending.data.artifactId })(invalidate, reject);
      invalidate();
    });
    const settled = await Promise.race([
      notification.then(decision => ({ kind: 'notification' as const, decision })),
      observation.then(execution => ({ kind: 'observation' as const, execution })),
    ]);
    if (settled.kind === 'observation' && !localDecision) return settled.execution;
    const decision = settled.kind === 'observation' ? await localDecision! : settled.decision;
    // Some hosts only present the approval id and leave the decision elsewhere.
    if (!decision) return result;
    if (!decision.ok) return decision;
    if (decision.result && typeof decision.result === 'object' && 'liveExecution' in decision.result) {
      const live = ActionExecuteResultSchema.safeParse(decision.result.liveExecution);
      if (live.success) return live.data;
    }
    if (settled.kind === 'observation') return settled.execution;
    return await observation;
  } finally {
    stopped = true;
    if (abortObservation) signal.removeEventListener('abort', abortObservation);
    lifetime.abort();
    await subscription?.dispose();
  }
}
