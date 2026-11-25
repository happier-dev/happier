import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { createExternalActionRuntime } from './externalActionRuntime.testkit';
import { createDaemonExternalActionContributedApprovalReplay, createDaemonExternalActionContributedInvoker } from './createDaemonExternalActionContributedInvoker';

it.each(['receiving', 'different'] as const)('replays an approved MCP Action on the %s Worker', async receiver => {
  let stored: TargetActionApprovalRequestV1 | null = null;
  const worker = { machineId: 'worker-machine', installationId: 'worker-installation' };
  const placement = { serverId: 'home', machineId: worker.machineId };
  let currentPlacement = placement;
  const runtime = createExternalActionRuntime('global', 'acme.worker-capture', context => {
    if (context.requesterAccount?.accountId !== 'alice' || context.chosenMachine?.machineId !== worker.machineId) {
      throw new PluginError({ code: 'capture_source_unavailable' });
    }
    expect(context.chosenMachine).toEqual(worker);
  }, undefined, () => currentPlacement, undefined, undefined, 'writesRemote', undefined, { surfaces: ['mcp'] });
  const lease = { registry: runtime, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
  const invoke = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: async () => lease,
    requestCurrentIntent: createTargetActionCurrentIntentAdapter({
      create: async request => { stored = request; return { artifactId: 'worker-capture-approval' }; }, read: async () => stored,
    }) });
  // Installation, Home currentness and Artifact persistence are host boundaries.
  const replay = createDaemonExternalActionContributedApprovalReplay({
    credentials: { token: 'fixture-token', encryption: null }, acquireRuntimeRegistryLease: async () => lease,
    isApprovalExecutionOriginCurrent: async () => true,
    readInstallationIdentity: () => ({ version: 1, installationId: worker.installationId, createdAt: 1,
      publicKey: Buffer.alloc(32).toString('base64url'), privateKey: Buffer.alloc(64).toString('base64url') }),
    targetActionApprovals: { targetActionApprovalsGet: async () => stored,
      targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; } },
  });
  const executor = createActionExecutor({ invokeContributedAction: invoke, approvalsGet: async () => stored, targetActionApprovalReplay: replay });
  try {
    expect(await executor.execute('action.invoke', { action: { pluginId: 'acme.worker-capture', localId: 'inspect' }, input: {} }, {
      surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' }, runtimeAccountId: 'alice',
      serverId: 'home', serverIdentityId: 'srv_home', actionRequestId: 'worker-capture-request',
      executionRunTargetMachineId: worker.machineId,
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(stored).toMatchObject({ replayPlacement: placement });
    if (receiver === 'different') currentPlacement = { ...placement, machineId: 'some-other-worker' };
    const result = await replay({ artifactId: 'worker-capture-approval', decision: 'approve' });
    expect(result, JSON.stringify(result)).toMatchObject(receiver === 'receiving'
      ? { ok: true, result: { status: 'executed', execution: { ok: true } } }
      : { ok: false, errorCode: 'plugin_action_execution_origin_mismatch' });
  } finally { await runtime.dispose(); }
});
