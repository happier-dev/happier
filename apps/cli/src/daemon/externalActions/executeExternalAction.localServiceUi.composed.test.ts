import '../../../../ui/sources/dev/vitestSetup';
import axios from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DaemonLocalServicePreviewOpenOrCreateResponseV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { IModal } from '../../../../ui/sources/modal/types';
import { primeServerFeaturesSnapshot } from '../../../../ui/sources/sync/api/capabilities/serverFeaturesClient';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';

const machineTransport = vi.hoisted(() => vi.fn());
const confirmModal = vi.hoisted(() => vi.fn<IModal['confirm']>());
vi.mock('../../../../ui/sources/modal', async () => (
  await import('../../../../ui/sources/dev/testkit/mocks/modal')
).createModalModuleMock({ spies: { confirm: (...args) => confirmModal(...args) } }).module);
vi.mock('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineTransport,
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
const { executeLocalServiceActionViaMachineRpc } = await import('../../../../ui/sources/sync/domains/local/services/actions/machineRpc');

beforeEach(async () => {
  await homes.reset();
  resetServerFeaturesClientForTests();
  machineTransport.mockReset();
  confirmModal.mockReset();
});
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

it.each(['localServices.actions.stopManaged', 'machines.services.control', 'localServices.actions.openPreview', 'localServices.preview.openOrCreate'] as const)(
  'controls A’s own Service on B through the real UI, Machine ingress and native owner: %s', async actionId => {
  const h = await createHarness(actionId, 'ask', false, 'srv_n2', undefined, false, false,
    { authentication: 'account', machineCustodianAccountId: 'host', machineRole: actionId === 'localServices.actions.openPreview' || actionId === 'localServices.preview.openOrCreate' ? 'use' : 'manage',
      ...(actionId === 'localServices.preview.openOrCreate' ? { additionalActionIds: ['localServices.preview.revoke'] } : {}) });
  try {
    const opening = actionId === 'localServices.actions.openPreview' || actionId === 'localServices.preview.openOrCreate';
    const workspace = actionId !== 'machines.services.control' ? await h.seedMoveService(opening ? 'http://127.0.0.1:42518' : null) : null;
    if (opening) {
      const post = vi.mocked(axios.post).getMockImplementation()!;
      vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
        if (new URL(String(url)).pathname !== '/v1/local-services/preview') return await post(url, body, config);
        // Home HTTP is the real credential boundary: a guest Open must mint the guest's viewer admission.
        expect(config?.headers?.Authorization).toBe('Bearer ' + h.humanToken);
        return { status: 200, data: { resource: body, accessUrl: 'https://guest.preview.example.test/', expiresAt: 61_000 } };
      });
    }
    const native = actionId === 'machines.services.control' ? await h.seedNativeService() : null;
    const seeded = workspace ?? native!;
    seeded.finishStop();
    const serverId = await homes.addHome({ name: 'Service Home', serverUrl: 'https://home.example.test',
      serverIdentityId: 'srv_n2', accountId: 'account', credentials: { token: h.humanToken }, currentAccount: true });
    await homes.requireUiApproval(serverId, actionId);
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
    const homeActionIds = actionId === 'localServices.preview.openOrCreate' ? [actionId, 'localServices.preview.revoke'] : [actionId];
    for (const homeActionId of homeActionIds) for (const path of [`/v1/actions/${homeActionId}/execution-authorization`, `/v1/actions/${homeActionId}`]) {
      homes.answer(serverId, path, { select: async input => {
        if (path === `/v1/actions/${homeActionId}`) {
          const signed = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
          expect(signed.executionAuthorization?.binding).toMatchObject({
            accountId: 'account', custodianAccountId: 'host', authentication: { kind: 'account' },
            actionId: homeActionId, requestId: signed.envelope.requestId,
          });
        }
        const result = await axios.post('https://home.example.test' + path, input,
          { headers: { Authorization: 'Bearer ' + h.humanToken } });
        return { status: result.status, body: result.data };
      } });
    }
    const request = workspace ? { requestId: 'ui-stop-on-worker', action: opening ? 'open_preview' as const : 'stop_managed' as const,
      target: workspace.request.currentTarget, force: false } : null;
    let confirm!: (confirmed: boolean) => void;
    const decision = new Promise<boolean>(resolve => { confirm = resolve; });
    let showConfirmation!: () => void;
    const confirmationPending = new Promise<void>(resolve => { showConfirmation = resolve; });
    confirmModal.mockImplementation(() => { showConfirmation(); return decision; });
    const execution = createDefaultActionExecutor().execute(actionId, actionId === 'localServices.preview.openOrCreate'
      ? { machineId: workspace!.request.currentTarget.machineId, serviceTarget: workspace!.request.currentTarget }
      : native
      ? { ...native.target, operation: 'stop' }
      : { ...request!, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request!) },
      { surface: 'ui', authority: 'present_user', serverId });
    // Own UI Ask is answered by the native confirmation. Hold only that
    // presentation boundary; the Account Action and signed ingress stay real.
    await Promise.race([confirmationPending, execution.then(result => {
      throw new Error('UI Action settled before confirmation: ' + JSON.stringify(result));
    })]);
    expect(confirmModal).toHaveBeenCalledTimes(1);
    expect(machineTransport).not.toHaveBeenCalled();
    expect(seeded.snapshot().state).not.toBe('stopped');
    expect(seeded.stopCalls()).toBe(0);
    expect(h.hasApproval()).toBe(false);
    confirm(true);
    const result = await execution;
    expect(result, JSON.stringify(result)).toMatchObject(opening
      ? { ok: true, result: { preview: { accessUrl: 'https://guest.preview.example.test/', resource: { owner: { kind: 'user', id: 'account' } } } } }
      : { ok: true });
    expect(seeded.snapshot().state).toBe(opening ? 'running' : 'stopped');
    expect(seeded.stopCalls()).toBe(opening ? 0 : 1);
    expect(confirmModal).toHaveBeenCalledTimes(1);
    expect(h.hasApproval()).toBe(false);
    expect(h.networkPaths.filter(path => path === `POST /v1/actions/${actionId}`)).toHaveLength(1);
    if (actionId === 'localServices.preview.openOrCreate') {
      const opened = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(result.ok ? result.result : null);
      await homes.requireUiApproval(serverId, 'localServices.preview.revoke');
      vi.spyOn(axios, 'delete').mockImplementation(async (url, config) => {
        expect(new URL(String(url)).pathname).toBe('/v1/local-services/preview/' + opened.preview.previewId);
        expect(config?.headers?.Authorization).toBe('Bearer ' + h.humanToken);
        return { status: 200, data: { ok: true } };
      });
      const revoked = await createDefaultActionExecutor().execute('localServices.preview.revoke', {
        machineId: workspace!.request.currentTarget.machineId,
        previewId: opened.preview.previewId, serviceTarget: workspace!.request.currentTarget,
      }, { surface: 'ui', authority: 'present_user', serverId });
      expect(revoked, JSON.stringify(revoked)).toMatchObject({ ok: true, result: { revoked: true,
        snapshot: { resources: [], previews: [] } } });
      expect(confirmModal).toHaveBeenCalledTimes(2);
      expect(seeded.snapshot().state).toBe('running');
      expect(seeded.stopCalls()).toBe(0);
    }

  } finally {
    await Promise.all(h.serviceInstances().map(service => service.stop()));
    await h.close();
  }
});
