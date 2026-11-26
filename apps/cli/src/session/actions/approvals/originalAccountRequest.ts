import { randomUUID } from 'node:crypto';
import type { ActionExecuteResult, ActionExecutorContext, ExternalActionTargetV1 } from '@happier-dev/protocol';
import { isActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ActionInvokeInputSchema } from '@happier-dev/protocol/actions/actionInvokeInput';
import { ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ACTION_OPERATION_GET_ACTION_ID_V1, ACTION_OPERATION_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { deriveApprovalRequestSourceIdFromIdentityV1 } from '@happier-dev/protocol/approvals/creation';
import { deriveAccountScopedArtifactIdV1 } from '@happier-dev/protocol/artifacts/idScope';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { executeLiveCliApprovalRequest, type CliApprovalRequestedHandler } from './deferredResult';

/** Home retains the original private result; Account pushes expose only its existing Ask. */
export async function executeOriginalAccountCliApprovalRequest(options: Readonly<{
  actionId: string;
  input?: unknown;
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
    const machineId = options.target.kind === 'machine' ? options.target.machineId : undefined;
    const present = options.onApprovalRequested.presentPendingChild;
    const invocation = present && machineId && options.actionId === ACTION_INVOKE_ACTION_ID_V1
      ? ActionInvokeInputSchema.safeParse(options.input) : undefined;
    const child = present && machineId && invocation?.success ? {
      present, machineId,
      requestIdentity: { actionId: buildQualifiedPluginContributionKey(invocation.data.action), requestId: options.requestId },
    } : undefined;
    const presented = new Set<string>();
    let operationSettled = false;
    let pendingOperationRead = false;
    let operationRead: Promise<void> | undefined;
    const readChildProgress = () => {
      if (!child || signal.aborted || operationSettled) return;
      pendingOperationRead = true;
      if (operationRead) return;
      const address = { serverId: options.context.serverId ?? options.homeId, machineId: child.machineId };
      const observe = async () => {
        const result = await options.execute(ACTION_OPERATION_LIST_ACTION_ID_V1, {
          ...address, requestIdentity: child.requestIdentity,
        }, { ...options.context, signal, actionRequestId: randomUUID() });
        if (!result.ok || signal.aborted) return;
        const page = ActionOperationListV1ResponseSchema.safeParse(result.result);
        let operation = page.success ? page.data.items[0] : undefined;
        while (operation && !signal.aborted) {
          if (operation.state !== 'accepted' && operation.state !== 'running') {
            operationSettled = true;
            return;
          }
          const progress = operation.progress;
          const receipt = progress?.kind === 'phase' && progress.phase === 'waiting_for_approval' ? progress.approval : undefined;
          if (receipt && receipt.artifactId !== artifactId && !presented.has(receipt.artifactId)) {
            presented.add(receipt.artifactId);
            child.present(receipt, options.requestId);
          }
          // Artifact birth can arrive before progress is visible, even on
          // shared Machines. The owner holds this read until a newer revision.
          const next = await options.execute(ACTION_OPERATION_GET_ACTION_ID_V1, {
            ...address, operationId: operation.operationId, waitForTerminal: true, sinceRevision: operation.revision,
          }, { ...options.context, signal, actionRequestId: randomUUID() });
          if (!next.ok || signal.aborted) return;
          const read = ActionOperationGetV1ResponseSchema.safeParse(next.result);
          if (!read.success || read.data.kind !== 'found') return;
          operation = read.data.operation;
        }
      };
      operationRead = (async () => {
        while (pendingOperationRead && !signal.aborted && !operationSettled) {
          pendingOperationRead = false;
          await observe().catch(() => { /* An observational read cannot settle the original HTTP invocation. */ });
        }
      })().finally(() => { operationRead = undefined; });
    };
    let stopped = false;
    let rootReadFinished = false;
    let invalidated = false;
    let reading: Promise<void> | undefined;
    const invalidate = () => {
      invalidated = true;
      if (reading || rootReadFinished || stopped || signal.aborted) return;
      reading = (async () => {
        while (invalidated && !stopped && !signal.aborted) {
          invalidated = false;
          const observed = await options.execute('approval.request.get', { artifactId },
            { ...options.context, signal, actionRequestId: randomUUID() });
          if (stopped || signal.aborted) return;
          // Connection can precede creation. Its eventual push invalidates this miss.
          if (!observed.ok) {
            if (observed.errorCode === 'approval_not_found') continue;
            lifetime.abort(observed);
            return;
          }
          const { request } = ApprovalRequestGetResultV1Schema.parse(observed.result);
          if (request.status === 'open') {
            // Deferred proposals are presented after the original HTTP returns.
            // Only an Ask that holds the live invocation needs its person prompted
            // while HTTP waits: a blocking flow, or a target's live-only operands.
            if ('kind' in request ? request.approvalInputCustody === 'live_only'
              : 'approval' in request && request.approval?.flow === 'blocking') {
              notify({ kind: 'approval_request_created', artifactId, actionId: options.actionId },
                'preview' in request ? request.preview : undefined);
            }
            rootReadFinished = true;
            if (!child) await observation.dispose();
            return;
          }
        }
      })().catch(error => { lifetime.abort(error); }).finally(() => { reading = undefined; });
    };
    const observation = observeAccountChanges({ token: options.token, serverUrl: options.serverHttpBaseUrl, ...(child ? {} : { entityId: artifactId }) }, {
      onChange: change => {
        readChildProgress();
        if (!change || change.t === 'account-change' || change.artifactId === artifactId) invalidate();
      },
      onError: error => { lifetime.abort(error); },
    });
    try {
      const result = await options.run(signal).catch(error => {
        if (error === signal.reason && isActionExecuteFailure(error)) return error;
        throw error;
      });
      // A transport can translate a pre-dispatch abort into cancellation.
      // A settled response or uncertain delivery still owns its outcome.
      const reason: unknown = signal.reason;
      return result?.ok === false && result.errorCode === 'cancelled' && isActionExecuteFailure(reason)
        ? reason : result;
    } finally {
      stopped = true;
      lifetime.abort();
      await observation.dispose();
      await reading;
      await operationRead;
    }
  } });
}
