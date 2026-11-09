import '../../../../ui/sources/dev/vitestSetup';
import axios from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { primeServerFeaturesSnapshot } from '../../../../ui/sources/sync/api/capabilities/serverFeaturesClient';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { publishHomeAccountChange } from '../../../../ui/sources/sync/runtime/orchestration/homeAccountChange';

const machineTransport = vi.hoisted(() => vi.fn());
vi.mock('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineTransport,
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
const { executeLocalServiceActionViaMachineRpc } = await import('../../../../ui/sources/sync/domains/local/services/actions/machineRpc');

beforeEach(async () => { await homes.reset(); resetServerFeaturesClientForTests(); });
afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary(); withdrawActiveProjectAccountRowsSnapshot(); });

it('preserves the real WORKER handler refusal at the UI control decoder', async () => {
  const h = await createHarness('localServices.actions.stopManaged', 'default', false, 'srv_n2', undefined, false, false,
    { authentication: 'account', machineCustodianAccountId: 'host', machineRole: 'manage' });
  try {
    const seeded = await h.seedMoveService();
    seeded.finishStop();
    let raw: unknown;
    machineTransport.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
      raw = await h.deliverMachineRpc(method, payload);
      return raw;
    });
    const request = { requestId: 'raw-ui-stop-on-worker', action: 'stop_managed' as const,
      target: seeded.request.currentTarget, force: false };
    const decoded = await executeLocalServiceActionViaMachineRpc({ serverId: 'srv_n2', request: {
      ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request),
    } });
    expect(raw).toMatchObject({ errorCode: 'requester_credentials_unavailable' });
    expect(decoded).toMatchObject({ ok: false, reason: 'refused', failure: { errorCode: 'requester_credentials_unavailable' } });
    expect(seeded.stopCalls()).toBe(0);
  } finally {
    await Promise.all(h.serviceInstances().map(service => service.stop()));
    await h.close();
  }
});

it.each(['localServices.actions.stopManaged', 'machines.services.control'] as const)(
  'stops A’s Service on B through the real UI, Machine ingress and native owner: %s', async actionId => {
  const h = await createHarness(actionId, 'ask', false, 'srv_n2', undefined, false, false,
    { authentication: 'account', machineCustodianAccountId: 'host', machineRole: 'manage' });
  try {
    const workspace = actionId === 'localServices.actions.stopManaged' ? await h.seedMoveService() : null;
    const native = actionId === 'machines.services.control' ? await h.seedNativeService() : null;
    const seeded = workspace ?? native!;
    seeded.finishStop();
    const serverId = await homes.addHome({ name: 'Service Home', serverUrl: 'https://home.example.test',
      serverIdentityId: 'srv_n2', accountId: 'account', credentials: { token: h.humanToken }, currentAccount: true });
    await homes.requireUiApproval(serverId, actionId);
    homes.answer(serverId, 'POST /v1/artifacts', { select: async input => {
      const result = await axios.post('https://home.example.test/v1/artifacts', input,
        { headers: { Authorization: 'Bearer ' + h.humanToken } });
      const artifactId = result.data.id as string;
      const path = '/v1/artifacts/' + artifactId;
      homes.answer(serverId, 'GET ' + path, { select: async () => ({ body:
        (await axios.get('https://home.example.test' + path,
          { headers: { Authorization: 'Bearer ' + h.humanToken } })).data }) });
      homes.answer(serverId, 'POST ' + path, { select: async body => {
        const updated = await axios.post('https://home.example.test' + path, body,
          { headers: { Authorization: 'Bearer ' + h.humanToken } });
        return { status: updated.status, body: updated.data };
      } });
      return { status: result.status, body: result.data };
    } });
    const features = FeaturesResponseSchema.parse(await (await fetch('https://home.example.test/v1/features')).json());
    for (const path of ['/v1/features', '/v1/features/authenticated']) homes.answer(serverId, path, { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    machineTransport.mockImplementation(({ method, payload }: { method: string; payload: unknown }) => h.deliverMachineRpc(method, payload));
    // Home HTTP and the physical lifecycle are system boundaries. The UI Action
    // host, requester carrier, real receiving daemon and Service owner stay real.
    for (const path of ['/v1/machines/machine', '/v1/machines']) {
      homes.answer(serverId, path, { select: async () => ({ body: (await axios.get('https://home.example.test' + path,
        { headers: { Authorization: 'Bearer ' + h.humanToken } })).data }) });
    }
    for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
      homes.answer(serverId, path, { select: async input => {
        const result = await axios.post('https://home.example.test' + path, input,
          { headers: { Authorization: 'Bearer ' + h.humanToken } });
        return { status: result.status, body: result.data };
      } });
    }
    const request = workspace ? { requestId: 'ui-stop-on-worker', action: 'stop_managed' as const,
      target: workspace.request.currentTarget, force: false } : null;
    let pendingApproval!: (artifactId: string) => void;
    const approvalPending = new Promise<string>(resolve => { pendingApproval = resolve; });
    const execution = createDefaultActionExecutor({
      onBlockingApprovalPending: ({ artifactId }) => pendingApproval(artifactId),
    }).execute(actionId, native
      ? { ...native.target, operation: 'stop' }
      : { ...request!, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request!) },
      { surface: 'ui', authority: 'present_user', serverId });
    // UI Ask may retain its invocation while the independent CLI approves it.
    // Observe that existing pending hook instead of awaiting the effect first.
    const artifactId = await Promise.race([approvalPending, execution.then(result => {
      expect(result, JSON.stringify({ result, networkPaths: h.networkPaths })).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(result.errorCode);
      return ActionApprovalRequestCreatedResultSchema.parse(result.result).artifactId;
    })]);
    expect(seeded.snapshot().state).not.toBe('stopped');
    expect(seeded.stopCalls()).toBe(0);
    expect(await h.runPublicCli({ artifactId, decision: 'approve' }, 'approval.request.decide', { yes: true }))
      .toMatchObject({ ok: true });
    publishHomeAccountChange(serverId, [artifactId], { changeKinds: ['artifact'] });
    expect(await execution).toMatchObject({ ok: true });
    expect(seeded.snapshot().state).toBe('stopped');
    expect(seeded.stopCalls()).toBe(1);
    expect(h.networkPaths.filter(path => path === `POST /v1/actions/${actionId}`)).toHaveLength(1);
    expect((await h.approval()).execution).toMatchObject({ ok: true });
  } finally {
    await Promise.all(h.serviceInstances().map(service => service.stop()));
    await h.close();
  }
});
