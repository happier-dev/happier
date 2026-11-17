import { z } from 'zod/mini';
import type { SocketRpcContinuationCall, SocketRpcContinuationHandler } from '@happier-dev/sync-client';
import { ProjectSetupConsentFailureDetailsV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionActorV1Schema } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { RpcLocalActionContext } from './types';
import type { ActionOperationReviewContinuation } from '@/daemon/actionOperations/actionOperationTypes';
import { ActionOperationProgressUpdateSchema, ActionOperationOwnerUpdateSchema } from '@/daemon/actionOperations/actionOperationTypes';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

const decision = z.strictObject({ reviewedEffectDigest: z.string().check(z.minLength(1)), skipForInvocation: z.boolean() });
const request = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('describe') }),
  z.strictObject({ kind: z.literal('progress'), update: ActionOperationProgressUpdateSchema }),
  z.strictObject({ kind: z.literal('ownerUpdate'), update: ActionOperationOwnerUpdateSchema }),
  z.strictObject({ kind: z.literal('waitForResume'), details: ProjectSetupConsentFailureDetailsV1Schema }),
]);
const response = z.strictObject({ actionRequestId: z.optional(z.string()), operationId: z.string().check(z.minLength(1)),
  actionId: z.optional(z.string()), actor: z.optional(z.nullable(ActionActorV1Schema)), reviewSupported: z.boolean() });
const reverse = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('review'), decision: z.optional(decision) }),
  z.strictObject({ kind: z.literal('stop') }),
]);
function unavailable(): Error {
  return Object.assign(new Error('Original checkout removal operation is unavailable'), { code: 'project_setup_operation_unavailable' });
}

/** The original runner remains the sole operation owner and terminal settler. */
export function createWorkspaceSyncSourceOperationContinuation(context: RpcLocalActionContext): SocketRpcContinuationHandler {
  let unsubscribe: (() => void) | undefined;
  const handler: SocketRpcContinuationHandler = async (value, call) => {
    const input = request.parse(value);
    if (!context.operationAcceptance || !context.operationProgress || !context.operationOwnerUpdate) throw unavailable();
    if (input.kind === 'describe') {
      unsubscribe ??= context.operationCancellation?.onRequest(() => {
        // The containing RPC owns cancellation/result custody; this delivers subsequent Stop requests too.
        void call({ kind: 'stop' }).catch(() => {});
      });
      return response.parse({ actionRequestId: context.actionRequestId,
        operationId: context.operationAcceptance.operationId, actionId: context.operationAcceptance.actionId,
        actor: context.operationAcceptance.actor, reviewSupported: !!context.operationReview });
    }
    if (input.kind === 'progress') context.operationProgress.update(input.update);
    else if (input.kind === 'ownerUpdate') context.operationOwnerUpdate.update(input.update);
    else {
      if (!context.operationReview) throw unavailable();
      await context.operationReview.waitForResume(input.details, { review: async choice => {
        const reviewed = await call({ kind: 'review', ...(choice ? { decision: choice } : {}) });
        return reviewed === null ? null : ProjectSetupConsentFailureDetailsV1Schema.parse(reviewed);
      } });
    }
    return null;
  };
  handler.dispose = () => unsubscribe?.();
  return handler;
}

/** Local ports on the admitted target; callbacks and native preparation stay in this invocation. */
export async function openWorkspaceSyncTargetOperationContinuation(
  channel: Readonly<{ call: SocketRpcContinuationCall; notify(params: unknown): Promise<void> }>, signal: AbortSignal,
  setReviewHandler: (handler: SocketRpcContinuationHandler) => void,
  requestStop: () => void,
): Promise<RpcLocalActionContext & { signal: AbortSignal; flushOperationUpdates(): Promise<void> }> {
  let review: Parameters<ActionOperationReviewContinuation['waitForResume']>[1];
  const cancellationListeners = new Set<() => void>();
  setReviewHandler(async value => {
    const input = reverse.parse(value);
    if (input.kind === 'stop') {
      if (signal.aborted) { for (const listener of cancellationListeners) listener(); }
      else requestStop();
      return null;
    }
    signal.throwIfAborted();
    if (!review) throw unavailable();
    return review.review(input.decision);
  });
  signal.throwIfAborted();
  const original = response.parse(await channel.call({ kind: 'describe' }));
  signal.throwIfAborted();
  let updates = Promise.resolve();
  let updateFailure: unknown;
  const update = (value: unknown) => {
    const payload = projectNativeJsonValueForTransport(value);
    updates = updates.then(async () => { await channel.notify(payload); }).catch(error => { updateFailure ??= error; });
  };
  let pendingProgress: z.infer<typeof ActionOperationProgressUpdateSchema> | undefined;
  let progressQueued = false;
  const updateProgress: NonNullable<RpcLocalActionContext['operationProgress']>['update'] = value => {
    // Keep the next PTY snapshot while its preceding notification is encoded.
    pendingProgress = { ...pendingProgress, ...value };
    if (progressQueued) return;
    progressQueued = true;
    updates = updates.then(async () => {
      const next = pendingProgress;
      pendingProgress = undefined; progressQueued = false;
      await channel.notify(projectNativeJsonValueForTransport({ kind: 'progress', update: next }));
    }).catch(error => { updateFailure ??= error; });
  };
  const flushOperationUpdates = async () => { await updates; if (updateFailure) throw updateFailure; };
  return {
    signal, actionRequestId: original.actionRequestId,
    operationAcceptance: { operationId: original.operationId, actionId: original.actionId, actor: original.actor,
      accept() { throw unavailable(); } },
    operationProgress: { update: updateProgress },
    operationOwnerUpdate: { update: value => update({ kind: 'ownerUpdate', update: value }) },
    operationCancellation: { onRequest(listener) {
      cancellationListeners.add(listener);
      // Transport loss also cancels native work when the source cannot deliver Stop.
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
      return () => { cancellationListeners.delete(listener); signal.removeEventListener('abort', listener); };
    } },
    ...(original.reviewSupported ? { operationReview: { waitForResume: async (details, producer) => {
      if (review || !producer) throw unavailable();
      review = producer;
      try { await flushOperationUpdates(); await channel.call({ kind: 'waitForResume', details }); }
      finally { review = undefined; }
    } } satisfies ActionOperationReviewContinuation } : {}),
    flushOperationUpdates,
  };
}
