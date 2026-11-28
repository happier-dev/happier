import { afterEach, expect, it } from 'vitest';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';

import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { executeContributedAction } from './executeContributedAction';

afterEach(() => getSharedBlockingApprovalCoordinator().dispose());

it('withdraws the preparation wait for a live-only CLI approval when its caller disconnects', async () => {
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
  const pending = executeContributedAction({ runtimeRegistry: runtime, actionId: 'acme.cli-approval/inspect',
    input: {}, approvalContext, requestCurrentIntent,
    context: { ...approvalContext, signal: caller.signal, approvalInputCustody: 'live_only', observePluginExecution: host.observePluginExecution },
    actionsSettings: { v: 1, actions: { 'acme.cli-approval/actions/inspect': { approvalRequiredSurfaces: ['cli'] } } },
  });
  expect(await Promise.race([waiting.then(() => 'waiting'), pending.then(() => 'settled')])).toBe('waiting');
  caller.abort();
  await expect(pending).resolves.toMatchObject({ matched: true, result: { ok: false, errorCode: 'plugin_action_aborted' } });
  expect(effects).toBe(0);
  expect(host.store.get({ accountId: 'account', machineId: 'machine' }, artifactId)).toBeNull();
});
