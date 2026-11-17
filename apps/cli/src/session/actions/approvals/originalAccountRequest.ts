import { randomUUID } from 'node:crypto';
import type { ActionExecuteResult, ActionExecutorContext, ExternalActionTargetV1 } from '@happier-dev/protocol';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { deriveApprovalRequestSourceIdFromIdentityV1 } from '@happier-dev/protocol/approvals/creation';
import { deriveAccountScopedArtifactIdV1 } from '@happier-dev/protocol/artifacts/idScope';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { executeLiveCliApprovalRequest, type CliApprovalRequestedHandler } from './deferredResult';

/** Home retains the original private result; Account pushes expose only its existing Ask. */
export async function executeOriginalAccountCliApprovalRequest(options: Readonly<{
  actionId: string;
  requestId: string;
  homeId: string;
  accountId: string;
  target: ExternalActionTargetV1;
  token: string;
  serverHttpBaseUrl: string;
  context: ActionExecutorContext;
  execute: ReturnType<typeof createActionExecutor>['execute'];
  onApprovalRequested: CliApprovalRequestedHandler;
  run(signal: AbortSignal): Promise<ActionExecuteResult | null>;
}>): Promise<ActionExecuteResult | null> {
  // Every Ask this invocation awaits, built-in or contributed target, is
  // identified by the invocation's own origin, as its creation owner derives it.
  const artifactId = deriveAccountScopedArtifactIdV1(options.accountId, deriveApprovalRequestSourceIdFromIdentityV1({
    homeId: options.homeId, accountId: options.accountId, requesterId: options.accountId,
    requestId: options.requestId, actionId: options.actionId, target: options.target,
  }));
  return await executeLiveCliApprovalRequest({ ...options, run: async (invocationSignal, notify) => {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([invocationSignal, lifetime.signal]);
    let stopped = false;
    let invalidated = false;
    let reading: Promise<void> | undefined;
    const invalidate = () => {
      invalidated = true;
      if (reading || stopped || signal.aborted) return;
      reading = (async () => {
        while (invalidated && !stopped && !signal.aborted) {
          invalidated = false;
          const observed = await options.execute('approval.request.get', { artifactId },
            { ...options.context, signal, actionRequestId: randomUUID() });
          if (stopped || signal.aborted) return;
          // Connection can precede creation. Its eventual push invalidates this miss.
          if (!observed.ok) {
            if (observed.errorCode === 'approval_not_found') continue;
            throw new Error(observed.errorCode);
          }
          const { request } = ApprovalRequestGetResultV1Schema.parse(observed.result);
          if (request.status === 'open') {
            // Deferred proposals are presented after the original HTTP returns.
            // Only an Ask that holds the live invocation needs its person prompted
            // while HTTP waits: a blocking flow, or a target's live-only operands.
            if ('kind' in request ? request.approvalInputCustody === 'live_only'
              : 'approval' in request && request.approval?.flow === 'blocking') {
              notify({ kind: 'approval_request_created', artifactId, actionId: options.actionId });
            }
            await observation.dispose();
            return;
          }
        }
      })().catch(error => { lifetime.abort(error); }).finally(() => { reading = undefined; });
    };
    const observation = observeAccountChanges({ token: options.token, serverUrl: options.serverHttpBaseUrl, entityId: artifactId }, {
      onChange: invalidate,
      onError: error => { lifetime.abort(error); },
    });
    try {
      return await options.run(signal);
    } finally {
      stopped = true;
      lifetime.abort();
      await observation.dispose();
      await reading;
    }
  } });
}
