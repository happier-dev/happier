import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createCliActionApprovalPresenter } from '@/cli/actions/approvalPrompt';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import type { PluginActionsServiceSeed } from '@/plugins/runtime/invocation/services/actions';
import { executeLiveCliApprovalRequest } from '@/session/actions/approvals/deferredResult';
import { createExternalActionRuntime } from './externalActionRuntime.testkit';
import { createSignedRootActionApprovalAcknowledgement } from './signedRootActionApproval';

it('shows a held child approval on stderr and returns the original CLI result', async () => {
  let seed: PluginActionsServiceSeed | undefined;
  let finish!: () => void;
  const effect = new Promise<void>(resolve => { finish = resolve; });
  const action = { pluginId: 'acme.cli-operation', localId: 'inspect' };
  const approval = { kind: 'approval_request_created' as const, artifactId: 'child-approval',
    actionId: 'scm.reviewWorkspace.materializePrepared' as const };
  let decisions = 0;
  const runtime = createExternalActionRuntime('global', action.pluginId, async () => {
    // The fixture's native effect publishes through the real invocation ports.
    seed!.finiteOperation!.operationOwnerUpdate.update({ progress: { phase: 'waiting_for_approval', label: 'Waiting for approval', approval } });
    seed!.finiteOperation!.operationAcceptance.accept(approval);
    await effect;
    throw new PluginError({ code: 'review_start_refused', message: 'Reviewer start was refused' });
  }, undefined, undefined, value => { seed = value; }, undefined, 'safe', undefined,
  { surfaces: ['cli'], operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } } });
  const host = createHostActionOperationRuntime({ machineId: 'machine', serverId: 'home', resolveAccountId: async () => 'account' });
  const owner = createSignedRootActionApprovalAcknowledgement();
  const executor = createActionExecutor({
    listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime, selection),
    invokeContributedAction: createCommittedContributedActionInvoker({
      acquireRuntimeRegistryLease: async () => ({ registry: runtime, source: 'active', durableRevision: 0, release: async () => {} }),
      observePluginExecution: host.observePluginExecution,
    }),
    runActionOperation: host.runActionOperation,
  });
  const context = { surface: 'cli', authority: 'present_user', runtimeAccountId: 'account', serverId: 'home',
    actionRequestId: 'cli-review-start' } satisfies ActionExecutorContext;
  const notices = vi.spyOn(console, 'error').mockImplementation(() => {});
  const options = {
    actionId: ACTION_INVOKE_ACTION_ID_V1,
    context,
    onApprovalRequested: createCliActionApprovalPresenter({ actionId: formatQualifiedPluginActionId(action),
      approve: true, json: true, envelopeKind: 'actions_invoke' }),
    execute: (async () => {
      decisions++;
      return { ok: true, result: {} };
    }) satisfies typeof executor.execute,
    run: (signal: AbortSignal, onApprovalRequested: (approval: ActionApprovalRequestCreatedResult) => void) => owner.execute({
      actionId: ACTION_INVOKE_ACTION_ID_V1,
      surface: 'cli',
      signal,
      onApprovalRequested,
      run: (signal, operationOwnerUpdate) => executor.execute(ACTION_INVOKE_ACTION_ID_V1, { action, input: {} },
        { ...context, signal, operationOwnerUpdate }),
    }),
  };
  let settled = false;
  const pending = executeLiveCliApprovalRequest(options).then(result => { settled = true; return result; });
  try {
    await expect.poll(() => notices.mock.calls.length > 0 || settled).toBe(true);
    expect(settled).toBe(false);
    expect(notices.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{
      v: 1, ok: true, kind: 'actions_invoke', data: { kind: 'approval_pending', artifactId: approval.artifactId,
        actionId: approval.actionId, requestId: context.actionRequestId, approveIn: 'app' },
    }]);
    expect(decisions).toBe(0);
    finish();
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'review_start_refused' });
  } finally {
    finish();
    await Promise.allSettled([pending, owner.close()]);
    notices.mockRestore();
  }
});
