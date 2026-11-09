import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';

afterEach(() => { vi.restoreAllMocks(); });

it.each(['succeeded', 'failed'] as const)('settles approved native Deploy from its terminal operation (%s)', async outcome => {
  const serverId = 'home';
  const machineId = 'controller';
  const operationId = 'approved-operation';
  const environment = createDeploymentEnvironmentDetailV1();
  const input = { serverId, environmentId: environment.environment.id, expectedRevision: 1,
    targetLinkId: environment.targetLinks[0].targetLink.id, expectedTargetLinkRevision: 1,
    requestKey: 'approved-deploy', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
  let stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'system' }, actionId: 'deployments.deploy', actionArgs: input, summary: 'Deploy',
    decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
      serverId, serverIdentityId: serverId, accountId: 'owner', machineId, target: { kind: 'machine', machineId },
      actionId: 'deployments.deploy', requestId: 'original-request' } });
  const runtime = createHostActionOperationRuntime({ serverId, machineId, resolveAccountId: async () => 'owner',
    generateOperationId: () => operationId });
  let release!: () => void;
  const completion = new Promise<void>(resolve => { release = resolve; });
  let accepted!: () => void;
  const acceptance = new Promise<void>(resolve => { accepted = resolve; });
  const receipt = { ok: true as const, environmentId: input.environmentId, revision: 2,
    deploymentId: 'native-receipt', deploymentRevision: 1, state: 'queued' as const };
  const terminal = { ...receipt, deploymentRevision: 2, state: 'running_unverified' as const };
  let effects = 0;
  // Home HTTP and the native worker transport are genuine external boundaries.
  // The deployment carrier, operation runner, approval claim and settlement stay real.
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    const path = new URL(request.url!).pathname;
    if (request.method === 'GET') return { status: 200, data: { ok: true,
      environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
    expect(path).toBe(`/v1/deployments/environments/${input.environmentId}/deploy`);
    expect(request.data).toMatchObject({ actionOperationId: operationId });
    return { status: 200, data: receipt };
  });
  const deployment = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
    admitAccount: async () => null, resolveRequestHeaders: async () => ({}),
    dispatchReceipt: async request => {
      effects++;
      request.context.operationAcceptance?.accept({ ok: true, environmentId: input.environmentId,
        revision: 2, kind: 'pending', actionOperationId: operationId });
      accepted();
      await completion;
      return outcome === 'succeeded' ? terminal
        : { ok: false, errorCode: 'deployment_image_unavailable', error: 'deployment_image_unavailable' };
    } });
  const credentials = { token: 'fixture-account', encryption: null };
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deployment, serverId, machineId,
    runActionOperation: runtime.runActionOperation,
    isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({ accountId: 'owner', machineId, serverId,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
      // Authenticated Account/profile responses and local identity are environment boundaries.
      isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }) }),
    // Substitute only the persistent Artifact boundary.
    approvalsGet: async () => structuredClone(stored),
    approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
  });
  const replay = executor.replayApprovedApprovalRequest({ artifactId: 'approval' });
  try {
    await Promise.race([acceptance, replay.then(result => { throw new Error(`Replay stopped before native acceptance: ${JSON.stringify(result)}`); })]);
    // Joining through the ordinary caller still gets a pending handle. This also
    // lets the assertion discriminate premature settlement without polling.
    await runtime.runActionOperation({ actionId: 'deployments.deploy', input,
      context: { actionRequestId: 'original-request' }, execute: async () => { throw new Error('Duplicate native effect'); } });
    expect(stored.status).toBe('executing');
    release();
    await replay;
    expect(effects).toBe(1);
    expect(runtime.store.get({ accountId: 'owner', machineId }, operationId)?.state).toBe(outcome);
    expect(stored).toMatchObject(outcome === 'succeeded'
      ? { status: 'executed', execution: { ok: true, result: terminal } }
      : { status: 'failed', execution: { ok: false, errorCode: 'deployment_image_unavailable' } });
  } finally {
    release();
    await replay;
    await runtime.runner.waitForTerminal({ accountId: 'owner', machineId }, operationId);
  }
});
