import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, getMachineSetupDesiredV1, MachineSetupPlanInputV1Schema } from '@happier-dev/protocol';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => { vi.restoreAllMocks(); });

it('plans a callable direct target with expired Home presence while retaining its offline host fact', async () => {
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null };
  const roster = [
    { id: 'local', active: false, activeAt: 1 },
    { id: 'remote', active: true, activeAt: Date.now() },
  ].map(({ activeAt, ...machine }) => ({ ...ExternalActionMachineBootstrapV1Schema.parse({ ...machine,
    revokedAt: null, replacedByMachineId: null }), activeAt }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (new URL(String(url)).pathname !== '/v1/machines') throw new Error('Only the Account roster is needed');
    return { status: 200, data: roster };
  });
  const reads: string[] = [];
  const nativePlan = (machineId: string) => createMachineSetupPlanAction({ homeId: 'home', machineId, apiMachine: {
    getMachineSetupDesiredSnapshot: () => {
      reads.push(machineId);
      return getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
        compareAndSwap: async () => { throw new Error('Plan cannot publish'); },
      });
    },
  } });
  const localPlan = nativePlan('local');
  const remotePlan = nativePlan('remote');
  let remoteRefusal: 'machine_offline' | 'permission_denied' | undefined;
  // The remote Machine RPC is a network boundary. Its receiving Plan owner is
  // real, as is the configured local transport's receiving Plan below.
  vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
    expect(request.machineId).toBe('remote');
    expect(request.method).toBe(RPC_METHODS.MACHINE_SETUP_PLAN);
    if (remoteRefusal) return { ok: false, errorCode: remoteRefusal, error: remoteRefusal };
    return remotePlan({ input: MachineSetupPlanInputV1Schema.parse(request.request),
      context: { surface: 'cli', authority: 'present_user' } });
  });
  const deps = createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
    serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.invalid',
    machineActionDirectTargetTransport: { machineId: 'local', invoke: async (method, request) => {
      expect(method).toBe(RPC_METHODS.MACHINE_SETUP_PLAN);
      return localPlan({ input: MachineSetupPlanInputV1Schema.parse(request),
        context: { surface: 'cli', authority: 'present_user' } });
    } },
  });
  const result = await createActionExecutor(deps).execute('machines.setup.plan', { homeId: 'home', machineId: 'remote',
    targets: ['local', 'remote'].map(machineId => ({ homeId: 'home', machineId })),
  }, { surface: 'cli', authority: 'present_user', serverId: 'home' });
  expect(result).toMatchObject({ ok: true, result: {
    targets: ['local', 'remote'].map(machineId => ({ homeId: 'home', machineId, plan: { desiredRevision: 0 } })),
    review: { machineId: 'remote', machines: [
      { machineId: 'local', online: false }, { machineId: 'remote', online: true },
    ] },
  } });
  expect(reads).toEqual(['local', 'remote']);

  // A positive roster can become stale before the target answers. Only its
  // explicit offline result is a per-target exclusion, never an access denial.
  roster[0] = { ...roster[0]!, active: true, activeAt: Date.now() };
  const review = { homeId: 'home', machineId: 'local', selectedMachineId: 'local',
    targets: ['remote', 'local'].map(machineId => ({ homeId: 'home', machineId })) };
  const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
  remoteRefusal = 'machine_offline';
  reads.length = 0;
  expect(await createActionExecutor(deps).execute('machines.setup.plan', review, context)).toMatchObject({ ok: true, result: {
    targets: [
      { homeId: 'home', machineId: 'remote', status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' },
      { homeId: 'home', machineId: 'local', plan: { desiredRevision: 0 } },
    ], review: { machineId: 'local' },
  } });
  expect(reads).toEqual(['local']);
  remoteRefusal = 'permission_denied';
  expect(await createActionExecutor(deps).execute('machines.setup.plan', review, context))
    .toMatchObject({ ok: false, errorCode: 'permission_denied' });
});
