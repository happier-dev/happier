import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/resolveApprovalExecutor';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { createExternalActionRuntime } from './externalActionRuntime.testkit';
import { createDaemonExternalActionContributedInvoker, createDaemonExternalActionContributedApprovalReplay } from './createDaemonExternalActionContributedInvoker';

// Artifact persistence is the boundary; admission, production, live custody and effects stay real.
it.each(['action', 'contributed', 'daemon-cli', 'standalone'] as const)('keeps Account-target approval custody at its live owner (%s entry)', async entry => {
  const artifactId = `ui-account-live-approval-${entry}`;
  let stored: TargetActionApprovalRequestV1 | null = null;
  let effects = 0;
  const runtime = createExternalActionRuntime('global', 'acme.account-ui', () => { effects++; }, undefined,
    () => ({ serverId: 'home', serverIdentityId: 'srv_home', machineId: 'daemon-own-machine' }),
    undefined, undefined, 'writesRemote', undefined, { surfaces: ['ui', 'cli'], placementBindings: [], executionTarget: 'account' });
  const lease = { registry: runtime, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
  const update = async ({ request }: { request: TargetActionApprovalRequestV1 }) => {
    if (!stored) throw new Error('Missing approval');
    const admitted = admitTargetActionApprovalTransition(stored, request);
    if (admitted.ok) stored = TargetActionApprovalRequestV1Schema.parse(request);
    return admitted;
  };
  const controller = new AbortController();
  const makeInvoker = entry === 'standalone' ? createCommittedContributedActionInvoker : createDaemonExternalActionContributedInvoker;
  const invoke = makeInvoker({ acquireRuntimeRegistryLease: async () => lease,
    requestCurrentIntent: createTargetActionCurrentIntentAdapter({
      create: async request => { stored = request; return { artifactId }; }, read: async () => stored, update,
    }) });
  const executor = createActionExecutor({ invokeContributedAction: invoke });
  const action = { pluginId: 'acme.account-ui', localId: 'inspect' };
  const input = { machineId: 'request-machine' };
  const context = {
    surface: entry === 'standalone' || entry === 'daemon-cli' ? 'cli' as const : 'ui' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const },
    serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'alice', actionRequestId: 'save-source',
    signal: controller.signal,
    ...(entry === 'daemon-cli' ? { executionRunTargetMachineId: 'daemon-own-machine' } : {}),
  };
  const pending = entry !== 'contributed'
    ? executor.execute('action.invoke', { action, input }, context)
    : invoke({ action, input, context, signal: controller.signal });
  try {
    await expect.poll(() => getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(1);
    const request = TargetActionApprovalRequestV1Schema.parse(stored);
    expect(resolveApprovalExecutor(request)).toEqual({ kind: 'live_invocation',
      ...(entry === 'standalone' ? {} : { daemonMachineId: 'daemon-own-machine' }) });
    if (entry === 'standalone') expect(request.replayPlacement).toBeUndefined();
    expect(request.executionOriginV1).toMatchObject({ surface: context.surface, accountId: 'alice', serverIdentityId: 'srv_home' });
    const replay = createDaemonExternalActionContributedApprovalReplay({
      credentials: { token: 'fixture-token', encryption: null }, acquireRuntimeRegistryLease: async () => lease,
      targetActionApprovals: { targetActionApprovalsGet: async () => stored, targetActionApprovalsUpdate: update },
    });
    const decider = createActionExecutor({ approvalsGet: async () => stored, targetActionApprovalReplay: replay });
    // A different Account's substituted subject must fail through the public deciding entry.
    stored = TargetActionApprovalRequestV1Schema.parse({ ...request, accountId: 'bob' });
    const refused = await decider.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', runtimeAccountId: 'bob',
    });
    expect(refused).toMatchObject({ ok: false });
    expect(effects).toBe(0);
    stored = request;
    expect(await decider.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice',
    })).toMatchObject({ ok: true, result: { status: 'approved' } });
    expect(await pending).toMatchObject({ ok: true });
    expect(effects).toBe(1);
    expect(stored).toMatchObject({ status: 'executed', execution: { ok: true, effectAttempted: true } });
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
    await runtime.dispose();
  }
});
