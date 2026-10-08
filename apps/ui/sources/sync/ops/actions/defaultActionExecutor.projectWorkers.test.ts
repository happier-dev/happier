import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getActionSpec, ProjectWorkerActionInputSchemasV1 } from '@happier-dev/protocol';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Only the addressed daemon network is replaced; Account capture and Action policy stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { executeProjectWorkerActionV1 } = await import('./projectWorkerActions');
let serverId = 'home';
beforeEach(async () => {
  await homes.reset(); await loadSyncSingletonForTests(); rpc.machine.mockReset();
  serverId = await homes.addHome({ name: 'Worker Home', serverUrl: 'https://worker-actions.test', accountId: 'owner' });
});
afterEach(async () => { await homes.reset(); });

describe('worker Actions through the captured UI Home', () => {
  it('queries the exact Machine without waking, preserves unknown load and receiving refusal', async () => {
    const input = { workspace: { serverId, refId: 'checkout' }, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite' };
    const status = { eligible: true, candidate: { serverId, machineId: 'worker' }, load: { kind: 'unknown' }, explanation: 'load_unknown' };
    rpc.machine.mockResolvedValueOnce(status);
    const owner = createDefaultActionExecutor();
    const context = { serverId, expectedAccountId: 'owner', surface: 'ui' as const };
    expect(await owner.execute('projects.worker.status', input, context)).toEqual({ ok: true, result: status });
    expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'worker', accountId: 'owner',
      method: 'projects.worker.status', payload: input }));
    const denied = { ok: false, errorCode: 'project_worker_access_denied', error: 'project_worker_access_denied' };
    rpc.machine.mockResolvedValueOnce(denied);
    expect(await owner.execute('projects.worker.status', input, context)).toEqual(denied);
    rpc.machine.mockResolvedValueOnce({ ...status, candidate: { serverId, machineId: 'other' } });
    expect(await owner.execute('projects.worker.status', input, context)).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('withdraws a late status response when the captured Account credential retires', async () => {
    const input = { workspace: { serverId, refId: 'checkout' }, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite' };
    rpc.machine.mockImplementationOnce(async () => {
      await homes.switchAccount(serverId, 'replacement');
      return { eligible: true, candidate: { serverId, machineId: 'worker' }, load: { kind: 'known', running: 0, queued: 0,
        accepting: true, runAtMost: null }, explanation: 'eligible' };
    });
    expect(await createDefaultActionExecutor().execute('projects.worker.status', input, {
      serverId, expectedAccountId: 'owner', surface: 'ui',
    })).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
  });

  it('returns the public helper retirement receipt to its invoker without borrowing the replacement Account', async () => {
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.worker.copy.retire': ['ui'] } },
    } }, version: 1 } });
    const example = ProjectWorkerActionInputSchemasV1['projects.worker.copy.retire'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.retire').examples!.voice!.argsExample!),
    );
    const request = { ...example, workspace: { ...example.workspace, serverId } };
    rpc.machine.mockImplementationOnce(async () => {
      await homes.switchAccount(serverId, 'replacement');
      return { status: 'retired' };
    });
    await expect(executeProjectWorkerActionV1('projects.worker.copy.retire', request, { expectedAccountId: 'owner' }))
      .resolves.toEqual({ status: 'retired' });
    expect(homes.findByServerUrl('https://worker-actions.test')?.accountId).toBe('replacement');
    expect(rpc.machine).toHaveBeenCalledTimes(1);
  });
});
