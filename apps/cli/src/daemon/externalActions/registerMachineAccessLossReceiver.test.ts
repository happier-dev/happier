import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { registerMachineAccessLossReceiver, type CleanupRequesterMachineTerminals } from './registerMachineAccessLossReceiver';
import { createStablePluginUiResourceWatchOwner } from '@/plugins/runtime/invocation/services/uiResourceWatch';
import { createAgentIsolationMemberOperations, type AgentIsolationMemberOperations } from '../agentIsolation/createAgentIsolationMemberOperations';
import { deriveAgentIsolationMemberIdentity } from '../agentIsolation/provisioning';
import { writeAgentIsolationMemberBinding } from '../agentIsolation/memberBindings';
import { createHostActionOperationRuntime } from '../actionOperations/createHostActionOperationRuntime';
import type { ManagedServiceNativeLifecycleV1 } from '@happier-dev/plugin-sdk/managed-services';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createManagedActivityInventory, type LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import {
  authorizeResolvedProjectExecLaunchForHost,
  createProjectNativeToolchainIoForHost,
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
    kind: 'workspace',
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
          io: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }) },
      },
      launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, env: {}, release() {} },
    }),
  });
}

describe('Machine access-loss installation custody receiver', () => {
  function fixture(mode: 'plain' | 'e2ee' = 'plain', readLiveWorkInventory?: () => Promise<LiveWorkInventoryV1>,
    createMembers?: (resolveInstallationId: () => string) => AgentIsolationMemberOperations,
    cleanupRequesterMachineResources?: CleanupRequesterMachineTerminals) {
    let installationId = 'installation-a';
    let current = true;
    let checks = 0;
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
          return current && (input.custodySubjectAccountId === undefined || input.custodySubjectAccountId === 'bob');
        },
      }) });
    registerMachineAccessLossReceiver(rpc, { machineId: 'machine-a',
      serverId: 'home', readLiveWorkInventory,
      resolveInstallationId: () => installationId,
      memberOperations: createMembers?.(() => installationId),
      cleanupRequesterMachineResources,
    });
    const request = { method: `machine-a:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
      params: { v: 1, subjectAccountId: 'bob' }, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN, machineAdmission };
    return { rpc, request, revoke: () => { current = false; },
      replace: () => { installationId = 'replacement'; }, readAdmissionChecks: () => checks };
  }

  it.each(['plain', 'e2ee'] as const)('settles known-empty interactive custody over %s transport', async (mode) => {
    const { rpc, request } = fixture(mode);
    expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
  });

  it('closes the withdrawn requester logs even when member retirement cannot settle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-access-loss-watch-'));
    const watches = createStablePluginUiResourceWatchOwner({ isPluginConsumerCurrent: () => false, readPluginOccurrenceId: () => null });
    const operations = createHostActionOperationRuntime({ machineId: 'machine-a', resolveAccountId: async () => 'alice' });
    const unused = (): never => { throw new Error('Unavailable member target cannot execute native setup'); };
    let disposed = 0;
    try {
      await watches.openHost({ accountId: 'bob', subscriptionId: 'logs', resource: {
        hostRead: 'machines.services.logs', input: { serverId: 'home', machineId: 'machine-a', serviceId: 'service' },
        expectedGeneration: 'generation', sourceRevision: 'source',
      }, async bind() { return { digest: `sha256:${'a'.repeat(64)}`, dispose() { disposed++; } }; } });
      const { rpc, request } = fixture('plain', undefined, () => createAgentIsolationMemberOperations({
        observeExecution: operations.observeExecution, operations, serverId: 'home', activeServerDir: directory,
        readActivityInventory: () => null, captureMetadataPort: unused, target: () => null,
        effects: { platform: 'linux', installedCli: '/opt/happier/cli/current/happier',
          readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: unused,
          elevation: { installationId: 'installation-a', installedCli: '/opt/happier/cli/current/happier', readPolicy: unused, observe: unused },
          backend: { observe: unused, apply: unused } },
      }), async ({ requesterAccountId }) => {
        await watches.retireHostAccount(requesterAccountId);
        return { kind: 'settled' };
      });
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'incomplete' });
      expect(disposed).toBe(1);
    } finally { watches.retire(); await rm(directory, { recursive: true, force: true }); }
  });

  it('reads the reconnect census without verifying back and refuses the next request after withdrawal', async () => {
    let checksAtIngress = -1;
    const current = fixture('plain', async () => {
      checksAtIngress = current.readAdmissionChecks();
      current.revoke();
      return { coverage: 'complete', items: [] };
    });
    const census = { ...current.request, params: { v: 1, kind: 'requesters' } };
    expect(await current.rpc.handleRequest(census)).toEqual({ kind: 'requesters', accountIds: [], coverage: 'complete' });
    expect(current.readAdmissionChecks()).toBe(checksAtIngress);
    expect(await current.rpc.handleRequest(census)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });

  it('leaves an admitted requester Project worker running after authenticated access loss', async () => {
    const owner = createProjectServiceOwner();
    const worker = await startRequesterWorker(owner);
    const { rpc, request } = fixture();
    try {
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
      expect(worker.snapshot().state).toBe('running');
      expect(owner.listProjectServices()).toEqual([worker]);
    } finally {
      await owner.dispose();
    }
  });

  it('recovers sessionless native work from the actual live inventory without a live Session', async () => {
    const owner = createProjectServiceOwner();
    const worker = await startRequesterWorker(owner);
    const inventory = createManagedActivityInventory({ producers: [owner.activity] });
    const { rpc, request } = fixture('plain', inventory.read);
    try {
      const census = { ...request, params: { v: 1, kind: 'requesters' } };
      expect(await rpc.handleRequest(census)).toEqual({ kind: 'requesters', accountIds: ['bob'], coverage: 'complete' });
      expect(worker.snapshot().state).toBe('running');
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
      expect(worker.snapshot().state).toBe('running');
      expect(await rpc.handleRequest(census)).toEqual({ kind: 'requesters', accountIds: ['bob'], coverage: 'complete' });
    } finally {
      inventory.dispose();
      await owner.dispose();
    }
  });

  it('skips Environment services in startup requester reconciliation without incomplete coverage', async () => {
    const owner = createProjectServiceOwner();
    let stops = 0;
    const service = await owner.superviseProject({ kind: 'environment', serverId: 'home', machineId: 'machine-a',
      environmentId: 'production', environmentInstanceId: 'production-a', deploymentId: 'deploy-a', composeService: 'web',
      serviceId: 'production-a/web', specIdentity: 'deploy-a', isCurrent: () => true,
      release: { environmentId: 'production', environmentInstanceId: 'production-a', deploymentId: 'deploy-a',
        machineId: 'machine-a', installationId: 'installation-a', rootPath: process.cwd(), manifestFingerprint: 'exact-a',
        assertCurrent: async () => {}, commit: async () => {}, abort: async () => {} },
      nativeEffects: { keys: [{ kind: 'composeProject', dockerEndpoint: 'local', projectName: 'production-a' }] },
      releaseObservation: async () => {},
      processSpec: { mode: { kind: 'native', builtinLifecycle: {
        inspect: async () => ({ phase: 'running', readiness: 'ready', endpoint: null }),
        stop: async () => { stops++; return { status: 'stopped' }; },
      } } },
    });
    const inventory = createManagedActivityInventory({ producers: [owner.activity] });
    const { rpc, request } = fixture('plain', inventory.read);
    try {
      expect(await rpc.handleRequest({ ...request, params: { v: 1, kind: 'requesters' } }))
        .toEqual({ kind: 'requesters', accountIds: [], coverage: 'complete' });
      expect(await rpc.handleRequest(request)).toEqual({ kind: 'settled' });
      expect(service.snapshot().nativePhase).toBe('running');
      expect(owner.listProjectServices()).toEqual([service]);
      expect(stops).toBe(0);
    } finally { inventory.dispose(); await owner.dispose(); }
  });

  it('keeps incomplete attribution visible while returning only exact-installation live requester subjects', async () => {
    const attribution = { serverId: 'home', accountId: 'bob', machineId: 'machine-a', installationId: 'installation-a' };
    const { rpc, request } = fixture('plain', async () => ({ coverage: 'unknown', items: [
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

  it('completes an admitted census under its captured installation and refuses the next request after replacement', async () => {
    let replace = () => {};
    const current = fixture('plain', async () => {
      replace();
      return { coverage: 'complete', items: [{ category: 'terminal', ownerRef: 'terminal', state: 'active',
        attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine-a', installationId: 'installation-a' } }] };
    });
    replace = current.replace;
    const census = { ...current.request, params: { v: 1, kind: 'requesters' } };
    expect(await current.rpc.handleRequest(census))
      .toEqual({ kind: 'requesters', accountIds: ['bob'], coverage: 'complete' });
    expect(await current.rpc.handleRequest(census)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });

  it.skipIf(process.platform !== 'linux').each(['live', 'retained'] as const)(
    'keeps retained member subjects when installation changes during the admitted %s census read', async phase => {
      const directory = await mkdtemp(join(tmpdir(), 'happier-access-loss-census-'));
      const member = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home',
        requester: { serverId: 'home', accountId: 'retained-member', machineId: 'machine-a', installationId: 'installation-a' } }),
        agentUid: 2401, agentGid: 2401 };
      const unused = (): never => { throw new Error('Read-only census must not execute setup or cleanup'); };
      const operations = createHostActionOperationRuntime({ machineId: 'machine-a', resolveAccountId: async () => 'alice' });
      let replace = () => {};
      let nativeReads = 0;
      let targetReads = 0;
      try {
        await writeAgentIsolationMemberBinding(directory, member);
        const current = fixture('plain', async () => {
          if (phase === 'live') replace();
          return { coverage: 'complete', items: [] };
        }, resolveInstallationId => createAgentIsolationMemberOperations({
          observeExecution: operations.observeExecution, operations, serverId: 'home',
          readActivityInventory: () => null, activeServerDir: directory, captureMetadataPort: unused,
          target: () => {
            targetReads++;
            return { homeServerIdentityId: 'home', machineId: 'machine-a', installationId: resolveInstallationId(),
              custodianAccountId: 'alice', encryptionMode: 'plain' };
          },
          effects: { platform: 'linux', installedCli: '/opt/happier/cli/current/happier',
            readRoots: () => [], readSessionsToReplace: () => 0, publishStatus: unused,
            elevation: { installationId: 'installation-a', installedCli: '/opt/happier/cli/current/happier', readPolicy: unused, observe: unused },
            // Native account observation is the OS boundary. The committed
            // private binding remains a recovery subject if its user is gone.
            backend: { observe: async step => {
              nativeReads++;
              if (phase === 'retained') replace();
              return { stepId: step.id, status: 'drifted', facts: { present: false } };
            }, apply: unused },
          },
        }));
        replace = current.replace;
        const census = { ...current.request, params: { v: 1, kind: 'requesters' } };
        expect(await current.rpc.handleRequest(census))
          .toEqual({ kind: 'requesters', accountIds: ['retained-member'], coverage: 'unknown' });
        expect(nativeReads).toBe(1);
        expect(targetReads).toBe(1);
        expect(await current.rpc.handleRequest(census)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(nativeReads).toBe(1);
        expect(targetReads).toBe(1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

  it('refuses forged and no-longer-current loss delivery without stopping Project work', async () => {
    const owner = createProjectServiceOwner();
    const worker = await startRequesterWorker(owner);
    const { rpc, request, revoke } = fixture();
    try {
      expect(await rpc.handleRequest({ ...request, authorization: undefined }))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      revoke();
      expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(worker.snapshot().state).toBe('running');
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
});
