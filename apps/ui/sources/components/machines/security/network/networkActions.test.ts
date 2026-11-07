import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MachineReachabilityInspectResultV1Schema, MachineReachabilityPlanV1Schema, MachineServiceRowV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createMachineFixture, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { inspectMachineNetwork, configureMachineNetwork } = await import('./networkActions');
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

const posture = { revision: 3, management: { providers: [], publicSsh: { kind: 'closed' } },
  defaultServiceIngress: { kind: 'none' } } as const;
const observed = MachineReachabilityInspectResultV1Schema.parse({ machineId: 'network-machine', metadataVersion: 4, posture, selections: [], observation: {
  revision: 7, management: { daemon: 'ready', providers: [], publicSsh: 'unknown' }, privateNetworks: [], ingress: [],
} });
const plan = MachineReachabilityPlanV1Schema.parse({ reviewedPlanDigest: 'a'.repeat(64), basis: {
  machineId: observed.machineId, installationId: 'installation-a', currentSelections: [],
  currentPostureRevision: 2, change: { kind: 'posture', posture }, occurrences: [], recipePlans: [],
} });

describe('M-P21E Network adapters through the real public Action owner', () => {
  it('consumes effective service bindings only while visible and follows a real binding change without another native inspect', async () => {
    const row = MachineServiceRowV1Schema.parse({ serviceId: 'web', name: 'Web', authority: 'project', lifecyclePurpose: 'deployment',
      environmentId: 'shop-production',
      generation: 'generation-a', state: 'running', watchId: 'watch-web', watchRevision: 'revision-a',
      capabilities: { start: true, stop: true, restart: true, logs: true, accounting: true },
      configuration: { ports: [{ target: 8080, published: '49153', bindAddress: '127.0.0.1', protocol: 'tcp' }] },
    });
    let services = { kind: 'snapshot' as const, services: [row] };
    let reads = 0;
    let deliver: (() => void) | undefined;
    const content = () => {
      const bytes = Buffer.from(JSON.stringify(services));
      return { contentType: 'application/json', bytesBase64: bytes.toString('base64'),
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };
    // Substitute only the Home HTTP Resource wire; Action admission, Resource
    // demand/delivery and the service/Network hooks remain production code.
    const actionId = 'machines.services.list';
    const path = `/v1/actions/${actionId}`;
    homes.answer(serverId, `${path}/execution-authorization`, { select: body => {
      const envelope = readEnvelope(body);
      return { body: { v: 1, token: 'network-services-proof', binding: {
        serverIdentityId: 'srv_network_actions', accountId: 'network-owner', authentication: { kind: 'account', tokenEpoch: 0 },
        actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'network-machine' },
        machineId: 'network-machine', installationId: 'installation-a', custodianAccountId: 'network-owner', accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
    } });
    homes.answer(serverId, path, { select: async (body, request) => {
      const envelope = readEnvelope(body);
      const continuation = envelope.resourceContinuation;
      let result: unknown = services;
      if (continuation?.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) {
        reads++;
        result = { ok: true, resource: continuation.params.resource, ...content() };
      } else if (continuation?.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
        result = { ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest };
      } else if (continuation?.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) {
        result = { ok: true, closed: true };
      } else if (continuation) {
        result = await new Promise(resolve => {
          const finish = (value: unknown) => {
            request.signal?.removeEventListener('abort', abort);
            deliver = undefined;
            resolve(value);
          };
          const abort = () => finish({ ok: true, status: 'idle' });
          deliver = () => finish({ ok: true, status: 'event', event: { version: 1, kind: 'invalidated',
            subscriptionId: continuation.params.subscriptionId, digest: content().digest } });
          request.signal?.addEventListener('abort', abort, { once: true });
          if (request.signal?.aborted) abort();
        });
      }
      return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } };
    } });
    execution = { ok: true, result: observed };
    const hook = await renderHook(({ enabled, needsManage }: { enabled: boolean; needsManage: boolean }) => useMachineNetwork({
      serverId, machineId: observed.machineId, enabled, reachable: true, needsManage,
    }), { initialProps: { enabled: true, needsManage: true } });
    try {
      await flushHookEffects();
      expect(hook.getCurrent().state).toBe('needsManage');
      expect(reads).toBe(0);
      expect(requests).toHaveLength(0);
      await hook.rerender({ enabled: false, needsManage: false });
      await flushHookEffects();
      expect(reads).toBe(0);
      expect(requests).toHaveLength(0);
      await hook.rerender({ enabled: true, needsManage: false });
      await vi.waitFor(() => expect(hook.getCurrent()).toHaveProperty('services.rows', [row]));
      expect(reads).toBe(1);
      expect(requests).toHaveLength(1);
      services = { ...services, services: [{ ...row, configuration: { ports: [{ target: 8080, published: '49154',
        bindAddress: '0.0.0.0', protocol: 'tcp' }] } }] };
      await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
      await act(async () => { deliver?.(); });
      await vi.waitFor(() => expect(hook.getCurrent()).toHaveProperty('services.rows', services.services));
      expect(reads).toBe(2);
      expect(requests).toHaveLength(1);
      await hook.rerender({ enabled: false, needsManage: false });
      await flushHookEffects();
      expect(reads).toBe(2);
      expect(requests).toHaveLength(1);
    } finally { await hook.unmount(); }
  });

  it('inspects and prepares the exact addressed Machine even when the active Home changes', async () => {
    await homes.addHome({ name: 'Other', serverUrl: 'https://other-network.test', accountId: 'other', currentAccount: true });
    execution = { ok: true, result: { ...observed, plan } };
    const target = { serverId, machineId: observed.machineId };
    const context = { expectedAccountId: 'network-owner' };
    expect(await inspectMachineNetwork(target, plan.basis.change, context)).toMatchObject({ ok: true, result: { plan } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ actionId: 'machines.reachability.inspect',
      target: { kind: 'machine', machineId: observed.machineId }, input: { ...target, change: plan.basis.change } });
  });

  it('configures only the reviewed owned-field basis through the same Action executor', async () => {
    execution = { ok: true, result: { ...observed, status: 'applied' } };
    expect(await configureMachineNetwork(serverId, plan, { expectedAccountId: 'network-owner' }))
      .toMatchObject({ ok: true, result: { status: 'applied', machineId: observed.machineId } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ actionId: 'machines.reachability.configure',
      target: { kind: 'machine', machineId: observed.machineId }, input: { serverId, machineId: observed.machineId,
        change: plan.basis.change, reviewedPlanBasis: plan.basis, reviewedPlanDigest: plan.reviewedPlanDigest } });
  });

  it('keeps controller refusal details and unknown native outcomes visible without a retry', async () => {
    const refused = { ok: false, errorCode: 'machine_unavailable', error: 'unavailable',
      details: { machineId: 'controller-c', role: 'controller' } };
    execution = refused;
    expect(await inspectMachineNetwork({ serverId, machineId: observed.machineId }, undefined,
      { expectedAccountId: 'network-owner' })).toMatchObject(refused);
    expect(requests).toHaveLength(1);
    execution = { ok: true, result: { ...observed, status: 'outcome_unknown', errorCode: 'native_result_unknown' } };
    expect(await configureMachineNetwork(serverId, plan, { expectedAccountId: 'network-owner' }))
      .toMatchObject({ ok: true, result: { status: 'outcome_unknown', errorCode: 'native_result_unknown' } });
    expect(requests).toHaveLength(2);
  });

  it('returns the canonical pending approval instead of reporting configure as applied or resubmitting it', async () => {
    execution = { ok: true, result: { kind: 'approval_request_created',
      artifactId: 'network-approval', actionId: 'machines.reachability.configure' } };
    expect(await configureMachineNetwork(serverId, plan, { expectedAccountId: 'network-owner' })).toEqual(execution);
    expect(requests).toHaveLength(1);
  });

  it('never demands the Manage-only inspect for a Use grantee and settles on needs-Manage', async () => {
    execution = { ok: true, result: observed };
    const hook = await renderHook(() => useMachineNetwork({
      serverId, machineId: observed.machineId, enabled: true, reachable: true, needsManage: true,
    }));
    try {
      await flushHookEffects();
      await act(async () => { await hook.getCurrent().refresh(); });
      expect(requests).toHaveLength(0);
      expect(hook.getCurrent()).toMatchObject({ state: 'needsManage', failure: null, read: { kind: 'unrequested' } });
    } finally { await hook.unmount(); }
  });

  it('reads only on visible demand and reconnect, keeps pushed facts, and joins explicit in-flight refreshes', async () => {
    const base = createMachineFixture({ id: observed.machineId, daemonState: { status: 'running', reachability: observed.observation } });
    const machine = { ...base, metadata: { ...base.metadata!, reachabilityPosture: plan.basis.change.kind === 'posture'
      ? plan.basis.change.posture : undefined, accessProviderSelections: [] } };
    storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
    const held = createDeferred<unknown>();
    const reconnected = createDeferred<unknown>();
    execution = held.promise;
    const hook = await renderHook((props: { enabled: boolean; reachable: boolean }) => useMachineNetwork({
      serverId, machineId: observed.machineId, needsManage: false, ...props,
    }), { initialProps: { enabled: false, reachable: true } });
    try {
      expect(requests).toHaveLength(0);
      await hook.rerender({ enabled: true, reachable: true });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(hook.getCurrent()).toMatchObject({ state: 'ready', refreshing: true, read: { kind: 'pending' } });
      expect(hook.getCurrent().facts.observation?.management.publicSsh).toBe('unknown');
      const first = hook.getCurrent().refresh();
      const second = hook.getCurrent().refresh();
      expect(second).toBe(first);
      await act(async () => {
        storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
          metadata: { ...machine.metadata, host: 'renamed-without-network-change' } }], false, { sourceServerId: serverId });
      });
      expect(requests).toHaveLength(1);
      held.resolve({ ok: true, result: observed });
      await act(async () => { await first; });
      expect(hook.getCurrent()).toMatchObject({ state: 'ready', refreshing: false, read: { kind: 'settled' } });
      await hook.rerender({ enabled: true, reachable: false });
      expect(hook.getCurrent()).toMatchObject({ stale: true, refreshing: false });
      expect(hook.getCurrent().facts.observation?.management.publicSsh).toBe('unknown');
      execution = reconnected.promise;
      await hook.rerender({ enabled: true, reachable: true });
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      await act(async () => {
        const refresh = hook.getCurrent().refresh();
        reconnected.resolve({ ok: true, result: observed });
        await refresh;
      });
      expect(hook.getCurrent().read.kind).toBe('settled');
      await hook.rerender({ enabled: false, reachable: true });
      expect(requests).toHaveLength(2);
    } finally {
      held.resolve({ ok: true, result: observed });
      reconnected.resolve({ ok: true, result: observed });
      await hook.unmount();
    }
  });
});
