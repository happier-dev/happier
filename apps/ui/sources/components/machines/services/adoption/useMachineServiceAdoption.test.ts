import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { MachineServiceAdoptResultV1 } from '@happier-dev/protocol/local/services/adoptionV1';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderHook, standardCleanup } from '@/dev/testkit';

// Only the Machine RPC transport is substituted: the Action front door, executor, admission and the hook stay real.
const machineTransport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(machineTransport.rpc);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useMachineServiceAdoption } = await import('./useMachineServiceAdoption');

let serverId: string;
const machineId = 'adopt-machine';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const review: MachineServiceAdoptResultV1 = {
  kind: 'review', reviewedDigest: DIGEST, originalProfiles: 'unknown', document: 'services:\n  web: {}\n  db: {}\n',
  variables: [{ name: 'MB_SITE_URL', phase: 'runtime', required: true, hasDefault: false },
    { name: 'POSTGRES_PASSWORD', phase: 'runtime', required: true, hasDefault: false }],
  services: ['web', 'db'], profiles: [], availableProfiles: ['tools'],
};
const destination = { name: 'Analytics', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
  projectSourceId: 'source' } as const;
const bindings = [
  { purpose: 'variable', name: 'MB_SITE_URL', phase: 'runtime', source: { kind: 'value', value: 'https://a.example' } },
  { purpose: 'variable', name: 'POSTGRES_PASSWORD', phase: 'runtime',
    source: { kind: 'secret', ref: 'happier:shared-secret:v1:secret-1', resourceRevision: 1 } },
] as const;


beforeEach(async () => {
  await homes.reset();
  machineTransport.rpc.mockReset();
  serverId = await homes.addHome({ name: 'Adopt', serverUrl: 'https://adopt.test', serverIdentityId: 'srv_adopt',
    accountId: 'adopt-owner', currentAccount: true });
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

function adoptCalls() {
  return machineTransport.rpc.mock.calls.map(([call]) => call as { method: string; payload: Record<string, unknown> })
    .filter(call => call.method === RPC_METHODS.MACHINES_SERVICE_ADOPT);
}

async function mount() {
  return await renderHook(() => useMachineServiceAdoption({ serverId, machineId,
    service: { serviceId: 'analytics', generation: 'gen-1' } }));
}

it('routes machines.services.adopt through the real Action front door to the Machine', async () => {
  machineTransport.rpc.mockImplementation(async () => review);
  const hook = await mount();
  await act(async () => { await hook.getCurrent().review([]); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'review' });
  expect(adoptCalls()).toHaveLength(1);
});

it('captures a value-free review once, then applies the reviewed digest with confirmed bindings', async () => {
  machineTransport.rpc.mockImplementation(async ({ payload }: { payload: { mode: string } }) =>
    payload.mode === 'review' ? review : { kind: 'adopted', environmentId: 'env-1', revision: 2, targetLinkId: 'link-1' });
  const hook = await mount();
  await act(async () => { await hook.getCurrent().review([]); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'review', review: { services: ['web', 'db'] } });
  expect(adoptCalls()[0]!.payload).toMatchObject({ serverId: 'srv_adopt', machineId, serviceId: 'analytics', expectedGeneration: 'gen-1',
    mode: 'review', profiles: [] });
  await act(async () => { await hook.getCurrent().apply({ destination, bindings }); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'adopted', environmentId: 'env-1' });
  const apply = adoptCalls()[1]!.payload;
  expect(apply).toMatchObject({ mode: 'apply', reviewedDigest: DIGEST, bindingsConfirmed: true, destination,
    bindings, requestKey: adoptCalls()[0]!.payload.requestKey, profiles: [] });
});

it('keeps a partial adoption truthful and continues it under the same request', async () => {
  let applies = 0;
  machineTransport.rpc.mockImplementation(async ({ payload }: { payload: { mode: string } }) => {
    if (payload.mode === 'review') return review;
    applies++;
    return applies === 1
      ? { kind: 'partial', environmentId: 'env-1', revision: 1, errorCode: 'outcome_unknown', preparedCreate: {
        serverId, requestKey: 'k', projectSourceId: 'source', protection: 'nonProduction', purpose: 'standard',
        deployerMode: 'managers', controllerMachineId: machineId, contentArtifactId: 'c', contentHeaderVersion: 1, contentBodyVersion: 1,
      } }
      : { kind: 'adopted', environmentId: 'env-1', revision: 2, targetLinkId: 'link-1' };
  });
  const hook = await mount();
  await act(async () => { await hook.getCurrent().review([]); });
  await act(async () => { await hook.getCurrent().apply({ destination, bindings }); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'partial', errorCode: 'outcome_unknown', environmentId: 'env-1' });
  await act(async () => { await hook.getCurrent().retry(); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'adopted' });
  const [, first, second] = adoptCalls();
  expect(second!.payload).toEqual(first!.payload);
});

it('settles a refusal on its step with the typed code, and re-reads when the future profiles change', async () => {
  machineTransport.rpc.mockImplementation(async ({ payload }: { payload: { mode: string; profiles: string[] } }) => {
    if (payload.mode === 'review') return { ...review, profiles: payload.profiles };
    return { ok: false, errorCode: 'secret_binding_required', error: 'secret_binding_required' };
  });
  const hook = await mount();
  await act(async () => { await hook.getCurrent().review(['tools']); });
  expect(adoptCalls()[0]!.payload).toMatchObject({ profiles: ['tools'] });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'review', review: { profiles: ['tools'] } });
  await act(async () => { await hook.getCurrent().apply({ destination, bindings }); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'failed', step: 'apply', code: 'secret_binding_required',
    review: { reviewedDigest: DIGEST } });
});


it('keeps one apply in flight and retains the exact request when retrying a refusal', async () => {
  let finish: ((value: unknown) => void) | undefined;
  machineTransport.rpc.mockImplementation(async ({ payload }: { payload: { mode: string } }) => {
    if (payload.mode === 'review') return review;
    return await new Promise(resolve => { finish = resolve; });
  });
  const hook = await mount();
  await act(async () => { await hook.getCurrent().review([]); });
  let pending: Promise<void> | undefined;
  await act(async () => { pending = hook.getCurrent().apply({ destination, bindings }); });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await act(async () => { await hook.getCurrent().apply({ destination, bindings }); });
  expect(adoptCalls().filter(call => call.payload.mode === 'apply')).toHaveLength(1);
  await act(async () => { finish!({ ok: false, errorCode: 'machine_unreachable', error: 'machine_unreachable' }); await pending; });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'failed', step: 'apply', code: 'machine_unreachable' });
  machineTransport.rpc.mockResolvedValue({ kind: 'adopted', environmentId: 'env-1', revision: 2, targetLinkId: 'link-1' });
  await act(async () => { await hook.getCurrent().retry(); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'adopted' });
  expect(adoptCalls()[2]!.payload).toEqual(adoptCalls()[1]!.payload);
});

it('starts a new application identity when the person changes a refused binding choice', async () => {
  machineTransport.rpc.mockImplementation(async ({ payload }: { payload: { mode: string } }) => payload.mode === 'review'
    ? review : { ok: false, errorCode: 'secret_binding_required', error: 'secret_binding_required' });
  const hook = await mount();
  await act(async () => { await hook.getCurrent().review([]); });
  await act(async () => { await hook.getCurrent().apply({ destination, bindings }); });
  const changed = [{ ...bindings[0], source: { kind: 'value' as const, value: 'https://changed.example' } }, bindings[1]];
  await act(async () => { await hook.getCurrent().apply({ destination, bindings: changed }); });
  const [, first, second] = adoptCalls();
  expect(second!.payload.bindings).toEqual(changed);
  expect(second!.payload.requestKey).not.toEqual(first!.payload.requestKey);
});

it('uses the canonical bindings editor for the reviewed destination draft before one apply', async () => {
  machineTransport.rpc.mockImplementation(async ({ payload }: { payload: { mode: string } }) => payload.mode === 'review'
    ? review : { kind: 'adopted', environmentId: 'env-1', revision: 2, targetLinkId: 'link-1' });
  const hook = await mount();
  await act(async () => { await hook.getCurrent().review([]); });
  await act(async () => { hook.getCurrent().setDestination(destination); });
  for (const binding of bindings) {
    await act(async () => { expect(hook.getCurrent().bindingsEditor.setVariable(binding)).toEqual({ ok: true }); });
  }
  await act(async () => { await hook.getCurrent().apply(); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'adopted' });
  expect(adoptCalls()[1]!.payload).toMatchObject({ destination, bindings });
  expect(hook.getCurrent().destination).toEqual(destination);
  expect(hook.getCurrent().bindings).toEqual(bindings);
});


it('keeps a late review from the previous generation out of the new adoption', async () => {
  let finish: ((value: unknown) => void) | undefined;
  machineTransport.rpc.mockImplementation(async () => await new Promise(resolve => { finish = resolve; }));
  const hook = await renderHook(({ generation }: { generation: string }) => useMachineServiceAdoption({ serverId, machineId,
    service: { serviceId: 'analytics', generation } }), { initialProps: { generation: 'gen-1' } });
  let pending: Promise<void> | undefined;
  await act(async () => { pending = hook.getCurrent().review([]); });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await hook.rerender({ generation: 'gen-2' });
  await act(async () => { finish!(review); await pending; });
  expect(hook.getCurrent().state).toEqual({ kind: 'idle' });
  await act(async () => { await hook.getCurrent().apply({ destination, bindings }); });
  expect(adoptCalls()).toHaveLength(1);
  const newDigest = `sha256:${'b'.repeat(64)}`;
  machineTransport.rpc.mockImplementation(async ({ payload }: { payload: { mode: string } }) => payload.mode === 'review'
    ? { ...review, reviewedDigest: newDigest }
    : { kind: 'adopted', environmentId: 'env-2', revision: 2, targetLinkId: 'link-2' });
  await act(async () => { await hook.getCurrent().review([]); });
  await act(async () => { await hook.getCurrent().apply({ destination, bindings }); });
  expect(adoptCalls()[2]!.payload).toMatchObject({ expectedGeneration: 'gen-2', reviewedDigest: newDigest });
  expect(adoptCalls()[2]!.payload.requestKey).not.toEqual(adoptCalls()[0]!.payload.requestKey);
});

it('retires the old Account review and draft before another Account can apply it', async () => {
  let finish: ((value: unknown) => void) | undefined;
  machineTransport.rpc.mockImplementation(async () => await new Promise(resolve => { finish = resolve; }));
  const hook = await mount();
  let pending: Promise<void> | undefined;
  await act(async () => { pending = hook.getCurrent().review([]); });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await act(async () => { await homes.switchAccount(serverId, 'second-owner', { currentAccount: true }); });
  await act(async () => { finish!(review); await pending; });
  expect(hook.getCurrent().state).toEqual({ kind: 'idle' });
  expect(hook.getCurrent().bindings).toEqual([]);
  expect(hook.getCurrent().destination).toBeNull();
  await act(async () => { await hook.getCurrent().apply({ destination, bindings }); });
  expect(adoptCalls()).toHaveLength(1);
});


it('clears a typed refusal while retaining the reviewed destination and bindings for correction', async () => {
  machineTransport.rpc.mockImplementation(async ({ payload }: { payload: { mode: string } }) => payload.mode === 'review'
    ? review : { ok: false, errorCode: 'secret_binding_required', error: 'secret_binding_required' });
  const hook = await mount();
  await act(async () => { await hook.getCurrent().review([]); });
  await act(async () => { hook.getCurrent().setDestination(destination); });
  for (const binding of bindings) {
    await act(async () => { expect(hook.getCurrent().bindingsEditor.setVariable(binding)).toEqual({ ok: true }); });
  }
  await act(async () => { await hook.getCurrent().apply(); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'failed', step: 'apply', code: 'secret_binding_required' });
  await act(async () => { hook.getCurrent().clearError(); });
  expect(hook.getCurrent().state).toMatchObject({ kind: 'review', review: { reviewedDigest: DIGEST } });
  expect(hook.getCurrent().destination).toEqual(destination);
  expect(hook.getCurrent().bindings).toEqual(bindings);
});
