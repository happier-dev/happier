import { describe, expect, it } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { registerMachineAccessLossReceiver } from './registerMachineAccessLossReceiver';
import { createRequesterMachineSessionAccessLossCleanup } from '../sessions/requesterMachineAccessLoss';
import { createStopSession } from '../sessions/stopSession';
import type { TrackedSession } from '../types';
import type { ManagedServiceNativeLifecycleV1 } from '@happier-dev/plugin-sdk/managed-services';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createManagedActivityInventory, type LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import {
  authorizeResolvedProjectExecLaunchForHost,
  createProjectNativeEnvironmentIoForHost,
} from '@/plugins/runtime/invocation/services/exec';

function createProjectServiceOwner() {
  return createManagedServicesOwner({
    processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
    dependencies: Object.freeze({}) as never,
    resolveScope: scope => scope,
  });
}

async function startRequesterWorker(
  owner: ReturnType<typeof createProjectServiceOwner>,
  nativeLifecycle?: ManagedServiceNativeLifecycleV1,
) {
  const root = process.cwd();
  return await owner.superviseProject({
    workspace: { id: 'workspace-a', serverId: 'home', machineId: 'machine-a', rootPath: root, createdAtMs: 1 },
    declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: 'worker' } },
    requester: { serverId: 'home', accountId: 'bob', machineId: 'machine-a', installationId: 'installation-a' },
    cwd: root,
    serviceId: 'project:workspace-a:manifest:worker',
    specIdentity: 'reviewed-worker-effect',
    isCurrent: () => true,
    processSpec: {
      mode: nativeLifecycle ? {
        kind: 'native',
        instance: { adapter: { pluginId: 'acme.native', localId: 'compose' }, nativeResourceId: 'exact-requester-native-project' },
        lifecycle: nativeLifecycle,
      } : { kind: 'managedSpawn', endpointNone: true },
      startupTimeoutMs: 1_000,
    },
    authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
      signal,
      assertCurrent() {},
      projectLaunch: {
        status: 'ready', reviewedEffectDigest: 'reviewed-worker-effect',
        environment: { selection: { kind: 'host' }, root, platform: process.platform,
          io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }) },
      },
      launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, env: {}, release() {} },
    }),
  });
}

describe('Machine access-loss installation custody receiver', () => {
  function fixture(mode: 'plain' | 'e2ee' = 'plain', services?: ReturnType<typeof createProjectServiceOwner>, readLiveWorkInventory?: () => Promise<LiveWorkInventoryV1>) {
    let installationId = 'installation-a';
    let current = true;
    let checks = 0;
    let changeOnFinalCheck = false;
    let revokeOnFinalCheck = false;
    const tracked = new Map<number, TrackedSession>();
    const cleanup = createRequesterMachineSessionAccessLossCleanup({ serverId: 'home', machineId: 'machine-a',
      pidToTrackedSession: tracked, stopSession: createStopSession({ pidToTrackedSession: tracked }) });
    const machineAdmission = { actorAccountId: 'alice', custodianAccountId: 'alice',
      machineId: 'machine-a', installationId, role: 'manage' as const, encryptionMode: mode };
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a',
      ...(mode === 'plain' ? { encryptionMode: 'plain' as const }
        : { encryptionMode: 'e2ee' as const, encryptionKey: new Uint8Array(32).fill(23), encryptionVariant: 'dataKey' as const }),
      logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
        resolveInstallationId: () => installationId,
        // Current Home admission is the replaced network boundary; all
        // transport parsing, receiver custody and authorization logic stay real.
        verifyMachineAdmission: async (input) => {
          checks += 1;
          if (changeOnFinalCheck && checks === 2) installationId = 'replacement';
          if (revokeOnFinalCheck && checks === 2) current = false;
          return current && (input.custodySubjectAccountId === undefined || input.custodySubjectAccountId === 'bob');
        },
      }) });
    registerMachineAccessLossReceiver(rpc, { machineId: 'machine-a',
      serverId: 'home', readLiveWorkInventory,
      resolveInstallationId: () => installationId, cleanupRequesterMachineSessions: cleanup,
      ...(services ? {
        cleanupRequesterMachineServices: async (input: Parameters<typeof cleanup>[0]) => {
          if (!await input.verifyCurrentMachineAdmission()) return { kind: 'incomplete' as const };
          const results = await services.stopForAccessLoss({
            serverId: 'home', accountId: input.requesterAccountId,
            machineId: input.machineId, installationId: input.installationId,
          });
          return await input.verifyCurrentMachineAdmission()
            && results.every(result => result.status === 'stopped' || result.status === 'cancelled_preparation')
            ? { kind: 'settled' as const } : { kind: 'incomplete' as const };
        },
      } : {}),
    });
    const request = { method: `machine-a:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
      params: { v: 1, subjectAccountId: 'bob' }, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN, machineAdmission };
    return { rpc, tracked, request, revoke: () => { current = false; },
      revokeAtFinalCheck: () => { revokeOnFinalCheck = true; },
      replaceAtFinalCheck: () => { changeOnFinalCheck = true; } };
  }

  it.each(['plain', 'e2ee'] as const)('settles known-empty requester Session custody over %s transport', async (mode) => {
    const { rpc, request, tracked } = fixture(mode);
    expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
    expect(tracked.size).toBe(0);
  });

  it('settles the exact requester Project worker through the same authenticated custody request', async () => {
    const owner = createProjectServiceOwner();
    const worker = await startRequesterWorker(owner);
    const { rpc, request } = fixture('plain', owner);
    try {
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
      expect(worker.snapshot().state).toBe('stopped');
      expect(owner.listProjectServices()).toEqual([]);
    } finally {
      await owner.dispose();
    }
  });

  it('recovers sessionless native work from the actual live inventory without a live Session', async () => {
    const owner = createProjectServiceOwner();
    const worker = await startRequesterWorker(owner);
    const inventory = createManagedActivityInventory({ producers: [owner.activity] });
    const { rpc, request, tracked } = fixture('plain', owner, inventory.read);
    try {
      const census = { ...request, params: { v: 1, kind: 'requesters' } };
      expect(await rpc.handleRequest(census)).toEqual({ kind: 'requesters', accountIds: ['bob'], coverage: 'complete' });
      expect(worker.snapshot().state).toBe('running');
      expect(tracked.size).toBe(0);
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
      expect(worker.snapshot().state).toBe('stopped');
      expect(await rpc.handleRequest(census)).toEqual({ kind: 'requesters', accountIds: [], coverage: 'complete' });
    } finally {
      inventory.dispose();
      await owner.dispose();
    }
  });

  it('keeps incomplete attribution visible while returning only exact-installation live requester subjects', async () => {
    const attribution = { serverId: 'home', accountId: 'bob', machineId: 'machine-a', installationId: 'installation-a' };
    const { rpc, request } = fixture('plain', undefined, async () => ({ coverage: 'unknown', items: [
      { category: 'terminal', ownerRef: 'terminal', state: 'active', attribution },
      { category: 'finite', ownerRef: 'operation', state: 'unknown', attribution },
      { category: 'service', ownerRef: 'other-installation', state: 'active', attribution: { ...attribution, accountId: 'cara', installationId: 'retired' } },
      { category: 'finite', ownerRef: 'retained-output', state: 'settled', attribution: { ...attribution, accountId: 'history-only' } },
      { category: 'input', ownerRef: 'unattributed', state: 'active', attribution: { kind: 'unknown' } },
    ] }));
    const census = { ...request, params: { v: 1, kind: 'requesters' } };
    expect(await rpc.handleRequest(census)).toEqual({ kind: 'requesters', accountIds: ['bob'], coverage: 'unknown' });
    expect(await rpc.handleRequest({ ...census, authorization: undefined })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });

  it('does not disclose a census after current installation admission is lost during the inventory read', async () => {
    let revoke = () => {};
    const current = fixture('plain', undefined, async () => {
      revoke();
      return { coverage: 'complete', items: [{ category: 'terminal', ownerRef: 'terminal', state: 'active',
        attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine-a', installationId: 'installation-a' } }] };
    });
    revoke = current.revoke;
    expect(await current.rpc.handleRequest({ ...current.request, params: { v: 1, kind: 'requesters' } }))
      .toEqual({ kind: 'incomplete' });
  });

  it('does not stop Project custody for forged or no-longer-current loss delivery', async () => {
    const owner = createProjectServiceOwner();
    const worker = await startRequesterWorker(owner);
    const { rpc, request, revokeAtFinalCheck } = fixture('plain', owner);
    try {
      expect(await rpc.handleRequest({ ...request, authorization: undefined }))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      revokeAtFinalCheck();
      expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(worker.snapshot().state).toBe('running');
    } finally {
      await owner.dispose();
    }
  });

  it('keeps unsupported native cleanup incomplete without retaining serving access', async () => {
    const owner = createProjectServiceOwner();
    let stoppable = false;
    const worker = await startRequesterWorker(owner, {
      // Native lifetime is the genuine system boundary, not a substitute owner.
      inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }),
      stop: async () => ({ status: stoppable ? 'stopped' : 'unsupported' }),
    });
    const { rpc, request } = fixture('plain', owner);
    try {
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'incomplete' });
      expect(worker.retirementSignal.aborted).toBe(true);
      expect(worker.snapshot().state).toBe('running');
      expect(owner.listProjectServices()).toEqual([worker]);
      stoppable = true;
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
      expect(worker.snapshot().state).toBe('stopped');
    } finally {
      stoppable = true;
      await owner.dispose();
    }
  });

  it('does not publish settled after the bound Home loss proof changes during service cleanup', async () => {
    const owner = createProjectServiceOwner();
    let revokeHome = () => {};
    const worker = await startRequesterWorker(owner, {
      inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }),
      stop: async () => {
        revokeHome();
        return { status: 'stopped' };
      },
    });
    const { rpc, request, revoke } = fixture('plain', owner);
    revokeHome = revoke;
    try {
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'incomplete' });
      expect(worker.snapshot().state).toBe('stopped');
    } finally {
      await owner.dispose();
    }
  });

  it('refuses public/local/peer calls and author-supplied identity fields', async () => {
    const { rpc, request } = fixture();
    for (const refused of [
      { ...request, authorization: undefined },
      { ...request, authorization: { ...request.authorization, forged: true } },
      { ...request, machineAdmission: undefined },
      { ...request, machineAdmission: { ...request.machineAdmission, actorAccountId: 'bob' } },
      { ...request, machineAdmission: { ...request.machineAdmission, machineId: 'machine-b' } },
      { ...request, machineAdmission: { ...request.machineAdmission, installationId: 'replacement' } },
      { ...request, params: { ...request.params, serverId: 'another-home' } },
    ]) expect(await rpc.handleRequest(refused)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS, {
      ...request.params, authorization: request.authorization, machineAdmission: request.machineAdmission,
    }, { verifiedPeerAuthority: 'present_user' })).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });

  it.each(['replacement', 'revocation'])('refuses %s during the final current Home check', async (change) => {
    const { rpc, request, replaceAtFinalCheck, revokeAtFinalCheck } = fixture();
    if (change === 'replacement') replaceAtFinalCheck();
    else revokeAtFinalCheck();
    expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });

  it('keeps offline admission and unconfirmed cleanup observably incomplete', async () => {
    const { rpc, request, tracked, revoke } = fixture();
    tracked.set(1, { pid: 1, startedBy: 'daemon', happySessionId: 'legacy' });
    expect(await rpc.handleRequest(request)).toEqual({ kind: 'incomplete' });
    revoke();
    expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(tracked.get(1)?.happySessionId).toBe('legacy');
  });
});
