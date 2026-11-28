import { afterEach, expect, it, vi } from 'vitest';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';

import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createSignedRootActionApprovalAcknowledgement } from '@/daemon/externalActions/signedRootActionApproval';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { executeContributedAction } from './executeContributedAction';

afterEach(() => getSharedBlockingApprovalCoordinator().dispose());

it('presents a live-only Ask to the signed CLI and withdraws it when the caller disconnects', async () => {
  let effects = 0;
  let artifact: TargetActionApprovalRequestV1 | null = null;
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const artifactId = 'cli-preparation-approval';
  // Only the Artifact persistence boundary is substituted. The coordinator,
  // target preparation, and operation admission run through their real owners.
  const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
    read: async () => artifact,
    update: async () => { throw new Error('No approval decision should be written'); },
    create: async request => { artifact = request; return { artifactId, request }; },
    subscribeChanges: () => { ready(); return { dispose() {} }; },
  });
  const runtime = createExternalActionRuntime('global', 'acme.cli-approval', () => { effects++; },
    undefined, undefined, undefined, undefined, 'writesRemote', undefined,
    { surfaces: ['cli'], operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' } } });
  const host = createHostActionOperationRuntime({ machineId: 'machine', serverId: 'home',
    resolveAccountId: async () => 'account', generateOperationId: () => artifactId });
  const caller = new AbortController();
  const approvalContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    runtimeAccountId: 'account', serverId: 'home' } satisfies ActionExecutorContext;
  const acknowledgement = createSignedRootActionApprovalAcknowledgement();
  const present = vi.fn();
  const pending = acknowledgement.execute({
    actionId: 'action.invoke', surface: 'cli', signal: caller.signal, onApprovalRequested: present,
    run: async (signal, operationOwnerUpdate) => {
      const attempt = await executeContributedAction({ runtimeRegistry: runtime, actionId: 'acme.cli-approval/inspect',
        input: {}, approvalContext: { ...approvalContext, operationOwnerUpdate }, requestCurrentIntent,
        daemonHoldsApprovalWaiter: true,
        context: { ...approvalContext, signal, approvalInputCustody: 'live_only', observePluginExecution: host.observePluginExecution },
        actionsSettings: { v: 1, actions: { 'acme.cli-approval/actions/inspect': { approvalRequiredSurfaces: ['cli'] } } },
      });
      if (!attempt.matched) throw new Error('Expected the contributed Action to be available');
      return attempt.result;
    },
  });
  try {
    expect(await Promise.race([waiting.then(() => 'waiting'), pending.then(() => 'settled')])).toBe('waiting');
    expect(present.mock.calls).toEqual([[{ kind: 'approval_request_created', artifactId, actionId: 'action.invoke' }]]);
  } finally {
    caller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_aborted' });
    await acknowledgement.close();
  }
  expect(effects).toBe(0);
  expect(host.store.get({ accountId: 'account', machineId: 'machine' }, artifactId)).toBeNull();
});
