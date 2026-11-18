import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import capturedInspect from './networkInspect78.fixture.json';
import { MachineReachabilityInspectResultV1Schema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createMachineFixture, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useMachineNetwork } = await import('./useMachineNetwork');
const { storage } = await import('@/sync/domains/state/storageStore');
const baseline = storage.getState();
let serverId: string;
const requests: Array<ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse> & Readonly<{ actionId: string }>> = [];
let execution: unknown;
function readEnvelope(body: unknown) {
  // The real transport posts a bare envelope for an own non-finite UI target;
  // requester/foreign placement carries the same envelope in the authorized wrapper.
  const direct = ExternalActionRequestEnvelopeV1Schema.safeParse(body);
  return direct.success ? direct.data : ExternalActionRequestEnvelopeV1Schema.parse(
    ExternalActionExecutionAuthorizationRequestV1Schema.parse(body).envelope,
  );
}
beforeEach(async () => {
  await homes.reset();
  requests.length = 0;
  serverId = await homes.addHome({ name: 'Network actions', serverUrl: 'https://network-actions.test',
    serverIdentityId: 'srv_network_actions', accountId: 'network-owner', currentAccount: true });
  const row = { ...createPlainMachineRowFixture({ id: 'network-machine', accountId: 'network-owner' }), installationId: 'installation-a' };
  homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
    body: await createMachineReadBatchResponseFixture(body, () => row).json(),
  }) });
  for (const actionId of ['machines.reachability.inspect', 'machines.reachability.configure']) {
    const path = `/v1/actions/${actionId}`;
    homes.answer(serverId, `${path}/execution-authorization`, { select: body => {
      const envelope = readEnvelope(body);
      return { body: { v: 1, token: 'network-action-proof', binding: {
        serverIdentityId: 'srv_network_actions', accountId: 'network-owner', authentication: { kind: 'account', tokenEpoch: 0 },
        actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'network-machine' },
        machineId: 'network-machine', installationId: 'installation-a', custodianAccountId: 'network-owner', accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
    } });
    homes.answer(serverId, path, { select: async body => {
      const envelope = readEnvelope(body);
      requests.push({ actionId, ...envelope });
      return { body: { v: 1, actionId, requestId: envelope.requestId, execution: await execution } };
    } });
  }
});
afterEach(async () => { standardCleanup(); await homes.reset(); storage.setState(baseline, true); });

describe('Network inspect result ownership', () => {
  it('keeps a typed transport cause when the inspect Action throws', async () => {
    execution = Promise.reject(new PluginError({ code: 'network_probe_denied', message: 'probe denied',
      failureCause: { phase: 'native.network.inspect', errorClass: 'Error', errorCode: 'network_probe_denied', httpStatus: 403 } }));
    void (execution as Promise<unknown>).catch(() => undefined);
    const hook = await renderHook(() => useMachineNetwork({ serverId, machineId: 'network-machine', enabled: true, reachable: true, needsManage: false }));
    await vi.waitFor(() => expect(hook.getCurrent().read.kind).toBe('failed'));
    expect(hook.getCurrent().failure).toMatchObject({ errorCode: 'outcome_unknown',
      failureCause: { phase: 'native.network.inspect', errorCode: 'network_probe_denied', httpStatus: 403 } });
    await hook.unmount();
  });

  it('shows the successful connected-owner inspect on a cold Network reader before a push arrives', async () => {
    // #78 public CLI response: preserve every native fact, including nativeFirewall.
    const inspected = MachineReachabilityInspectResultV1Schema.parse(capturedInspect);
    const row = { ...createPlainMachineRowFixture({ id: inspected.machineId, accountId: 'network-owner' }), installationId: 'installation-a' };
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
      body: await createMachineReadBatchResponseFixture(body, () => row).json(),
    }) });
    homes.answer(serverId, '/v1/actions/machines.reachability.inspect/execution-authorization', { select: body => {
      const envelope = readEnvelope(body);
      return { body: { v: 1, token: 'network-action-proof', binding: {
        serverIdentityId: 'srv_network_actions', accountId: 'network-owner', authentication: { kind: 'account', tokenEpoch: 0 },
        actionId: 'machines.reachability.inspect', requestId: envelope.requestId,
        target: { kind: 'machine', machineId: inspected.machineId }, machineId: inspected.machineId,
        installationId: 'installation-a', custodianAccountId: 'network-owner', accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
    } });
    execution = { ok: true, result: inspected };
    const input = { serverId, machineId: inspected.machineId, enabled: true, reachable: true, needsManage: false };
    const hook = await renderHook(() => useMachineNetwork(input));
    try {
      await vi.waitFor(() => expect(hook.getCurrent().read.kind).toBe('settled'));
      expect(requests).toHaveLength(1);
      expect(hook.getCurrent()).toMatchObject({ state: 'ready', failure: null,
        facts: { observation: inspected.observation, posture: inspected.posture } });
      const held = createDeferred<unknown>();
      execution = held.promise;
      let refresh: Promise<void> | undefined;
      await act(async () => { refresh = hook.getCurrent().refresh(); });
      expect(hook.getCurrent()).toMatchObject({ state: 'ready', refreshing: true,
        facts: { observation: inspected.observation } });
      await act(async () => { held.resolve({ ok: true, result: inspected }); await refresh; });
      const newer = { ...inspected.observation, revision: inspected.observation.revision + 1,
        management: { ...inspected.observation.management, publicSsh: 'closed' as const } };
      const published = createMachineFixture({ id: inspected.machineId,
        daemonState: { status: 'running', reachability: newer } });
      await act(async () => storage.getState().applyMachines([{ ...published,
        metadata: { ...published.metadata!, reachabilityPosture: inspected.posture ?? undefined,
          accessProviderSelections: inspected.selections } }], false, { sourceServerId: serverId }));
      expect(hook.getCurrent()).toMatchObject({ state: 'ready', facts: { observation: newer } });
      expect(requests).toHaveLength(2);
    } finally { await hook.unmount(); }
  });
});
