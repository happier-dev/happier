import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';

afterEach(() => { vi.restoreAllMocks(); });

it.each(['effect-started', 'admission-pending', 'receipt-unreadable'] as const)(
  'a lost UI replay reply during %s cannot settle the daemon-owned Deploy before its successful effect', async phase => {
    const actionId = 'deployments.deploy';
    const environment = createDeploymentEnvironmentDetailV1();
    const input = { serverId: 'home', environmentId: environment.environment.id, expectedRevision: 4,
      targetLinkId: environment.targetLinks[0].targetLink.id, expectedTargetLinkRevision: 1, requestKey: 'native-effect',
      contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
    let stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: input, summary: 'Deployment',
      decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 },
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'home', accountId: 'owner', machineId: 'controller',
        target: { kind: 'machine', machineId: 'controller' }, actionId, requestId: 'original-request' } });
    let accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    let admit!: () => void;
    const admission = new Promise<void>(resolve => { admit = resolve; });
    let unreadable = false;
    let effects = 0;
    const terminal = { ok: true as const, environmentId: input.environmentId, revision: 5,
      deploymentId: 'native-receipt', deploymentRevision: 2, state: 'succeeded' as const };
    // Only Home HTTP, Artifact persistence, and the inter-process reply are substituted.
    // Both approval executors, native deployment transport, operation and settlement stay real.
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      if (request.method === 'GET') return { status: 200, data: { ok: true,
        environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
      effects++;
      accepted();
      await completion;
      return { status: 200, data: terminal };
    });
    const deployment = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
      admitAccount: async () => null, resolveRequestHeaders: async () => ({}),
      dispatchReceipt: async () => { throw new Error('Terminal receipt cannot dispatch again'); } });
    const runtime = createHostActionOperationRuntime({ serverId: 'home', machineId: 'controller', resolveAccountId: async () => 'owner' });
    const deps = { ...createUnavailableActionTransportDeps(), ...deployment, serverId: 'home', machineId: 'controller',
      runActionOperation: runtime.runActionOperation,
      isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({ accountId: 'owner',
        machineId: 'controller', serverId: 'home',
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'controller' }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture-account', encryption: null } }),
        isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }) }),
      approvalsGet: async () => {
        if (unreadable) { unreadable = false; throw new Error('Artifact receipt read unavailable'); }
        return structuredClone(stored);
      },
      approvalsUpdate: async ({ request, expectedStatus }: Parameters<NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsUpdate']>>[0]) => {
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (transition.ok) stored = next;
        return transition;
      } };
    const daemon = createActionExecutor(deps);
    let replay: ReturnType<typeof daemon.replayApprovedApprovalRequest> | undefined;
    const ui = createActionExecutor({ ...deps, approvalRequestApprovedReplay: async ({ onReplayDispatched }) => {
      onReplayDispatched?.();
      // The remote process can still be preparing requester admission when
      // the deciding process loses the reply, as in READY71's Project-open.
      replay = admission.then(() => daemon.replayApprovedApprovalRequest({ artifactId: 'approval', callerAuthority: 'present_user' }));
      if (phase === 'effect-started') {
        admit();
        await Promise.race([acceptance, replay.then(result => { throw new Error(`Native effect not reached: ${JSON.stringify(result)}`); })]);
      }
      unreadable = phase === 'receipt-unreadable';
      throw new Error('Lost Machine transport reply');
    } });
    try {
      const decided = await ui.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' },
        { surface: 'ui', authority: 'present_user', serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner' });
      expect(stored, JSON.stringify({ decided, execution: stored.execution })).toMatchObject({
        status: phase === 'effect-started' ? 'executing' : 'approved',
      });
      expect(stored.execution).toBeUndefined();
      if (phase === 'effect-started') expect(decided).toMatchObject({ ok: true, result: { status: 'executing' } });
      else {
        expect(decided).toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
        expect(effects).toBe(0);
      }
      admit();
      finish();
      await replay;
      expect(stored).toMatchObject({ status: 'executed', execution: { ok: true, result: terminal } });
      expect(await ui.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' },
        { surface: 'ui', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: true,
          result: { status: 'executed', execution: { ok: true, result: terminal } } });
      expect(effects).toBe(1);
    } finally { admit(); finish(); await replay; }
  });

it.each(['deployments.teardown', 'session.goal.set', 'projects.prepare', 'workspace.sync.conflict.resolve'] as const)(
  'a deciding UI observes the independent %s executor claim and its later receipt', async actionId => {
    const input = actionId === 'deployments.teardown'
      ? { serverId: 'home', environmentId: 'environment', expectedRevision: 4, targetLinkId: 'link',
          expectedTargetLinkRevision: 1, requestKey: 'stop-remove', reason: 'manual',
          contentArtifactId: 'intent', contentHeaderVersion: 1, contentBodyVersion: 1 }
      : actionId === 'session.goal.set' ? { sessionId: 'session', objective: 'Ship', resumeInactiveWithInitialGoal: false }
      : actionId === 'projects.prepare' ? { workspace: { serverId: 'home', machineId: 'controller', workspaceId: 'checkout', rootPath: '/repo' }, phase: 'setup' }
      : { controllerMachineId: 'controller', hubWorkspaceRefId: 'checkout', path: 'src/index.ts',
          source: { workspaceRefId: 'checkout', expected: { kind: 'file', digest: 'a'.repeat(40), executable: false, size: 12 } },
          targets: [{ workspaceRefId: 'peer', expected: { kind: 'file', digest: 'b'.repeat(40), executable: false, size: 12 } }],
          relationshipIds: ['relationship'], strategy: 'use_source' };
    let stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: input, summary: 'Action',
      decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 },
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'home', accountId: 'owner', machineId: 'controller',
        target: { kind: 'machine', machineId: 'controller' }, actionId, requestId: 'original-request' } });
    const ui = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      approvalsGet: async () => structuredClone(stored),
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      // Machine RPC and persistent Artifact storage are boundaries. This fixture
      // represents another process's claim, then loses only its transport reply.
      approvalRequestApprovedReplay: async ({ onReplayDispatched }) => {
        onReplayDispatched?.();
        stored = ApprovalRequestV2Schema.parse({ ...stored, status: 'executing', updatedAtMs: 3 });
        throw new Error('Lost Machine reply');
      } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home',
      serverIdentityId: 'home', runtimeAccountId: 'owner' };
    expect(await ui.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, context))
      .toMatchObject({ ok: true, result: { status: 'executing' } });
    expect(stored.status).toBe('executing');
    const terminal = actionId === 'deployments.teardown'
      ? { ok: true, environmentId: 'environment', revision: 5, deploymentId: 'stop-receipt',
          deploymentRevision: 2, state: 'succeeded' }
      : actionId === 'session.goal.set' ? { updated: true }
      : actionId === 'projects.prepare' ? { operation: { version: 1, operationId: 'prepare', revision: 2,
          actionId, scope: { accountId: 'owner', machineId: 'controller' }, state: 'succeeded', title: 'Prepare', createdAt: 1 } }
      : { endpoints: [{ workspaceRefId: 'peer', status: 'applied' }] };
    stored = ApprovalRequestV2Schema.parse({ ...stored, status: 'executed', updatedAtMs: 4,
      execution: { executedAtMs: 4, ok: true, effectAttempted: true, result: terminal } });
    expect(await ui.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, context))
      .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: terminal } } });
  });
