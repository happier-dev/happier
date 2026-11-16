import { describe, expect, it, vi } from 'vitest';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import type { ConnectedServicePoolSelectionRead } from '@/api/machine/rpcHandlers.connectedAccounts';
import { createLinuxVitalsFixture } from './vitals/readers/linux.testkit';
import { createLinuxMachineVitalsReader } from './vitals/readers/linux';
import { createMinuteHistoryStore } from './vitals/history/minuteHistoryStore';
import { createMachineVitalsSampler } from './vitals/createMachineVitalsSampler';
import type { DaemonMachineVitalsRoutes } from '@/rpc/handlers/daemonMachineVitals';
import { join } from 'node:path';
import type { RpcHandlerContext, RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachineProcessesAnswerV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { createProcessOwnershipRuntime } from './processes/ownership/processOwnershipRuntime';
import { createLeftBehindPass } from './processes/leftBehind/leftBehindPass';
import { DaemonComputerActionExecuteResponseV1Schema } from '@happier-dev/protocol/computer/v1';
import { ApiMachineClient } from '@/api/apiMachine';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createComputerRoutes } from './computer/routes';
import { createMachineLiveStreamCaptureRegistry } from './peer/mediation/stream/captureRegistry';

describe('daemon machine RPC route attachments', () => {
  it('keeps installed Setup receivers through prepare, attachment and transport replacement', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const cache = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => null });
    cache.attachMachineReachabilityRoutes({ target: () => null,
      agentIsolation: { read: () => undefined },
      adminAccess: { observer: createMachineAdminAccessObserver({ onChanged: async () => {} }) },
      getMachineClient: () => null });
    const clients: ApiMachineClient[] = [];
    try {
      for (const id of ['initial', 'replacement']) {
        const client = new ApiMachineClient('test-token', { id, encryptionMode: 'plain',
          metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        clients.push(client);
        cache.prepareApiMachineForSessions(client);
        cache.attachApiMachineForSessions(client);
        cache.attachApiMachineForSessions(client);
        const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
        if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
        expect(manager.hasHandler('machines.reachability.inspect')).toBe(true);
      }
    } finally { for (const client of clients) client.shutdown(); }
  });
  it('dispatches Computer RPC after delayed machine attachment and transport replacement, including unavailable owners', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    let active: ApiMachineClient | null = null;
    const cache = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => active });
    const routes = createComputerRoutes({ machineId: 'machine-computer', machineDisplayName: 'QA desktop',
      defaultDisplayId: 'unsupported-native-display', registry: createMachineLiveStreamCaptureRegistry() });
    let current: typeof routes | null = routes;
    const clients: ApiMachineClient[] = [];
    const attach = () => {
      const client = new ApiMachineClient('computer-test-token', { id: 'machine-computer', encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      clients.push(client);
      active = client;
      cache.attachApiMachineForSessions(client);
      // Observe the real transport owner without adding a production inspection seam.
      const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
      if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
      return manager;
    };
    const list = async (manager: RpcHandlerManager, authority: 'present_user' | 'account_automation') =>
      DaemonComputerActionExecuteResponseV1Schema.parse(await manager.invokeLocal(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
        { sessionId: 'session-computer', actionId: 'computer.targets.list', input: { machineId: 'machine-computer' } },
        { verifiedPeerAuthority: authority })).result;
    try {
      cache.attachDevicesRoleRoutes({ resolveComputer: () => current });
      const first = attach();
      // No native process is launched for an unsupported display; real routes return a typed refusal.
      expect(await list(first, 'present_user')).toMatchObject({ ok: false, errorCode: 'target_unsupported' });
      expect(await list(first, 'account_automation')).toMatchObject({ ok: false, errorCode: 'approval_required' });
      const replacement = attach();
      expect(await list(replacement, 'present_user')).toMatchObject({ ok: false, errorCode: 'target_unsupported' });
      current = null;
      expect(await list(replacement, 'present_user')).toEqual({ ok: false, errorCode: 'computer_unavailable', error: 'computer_unavailable' });
      // Owner publication after the transport already exists follows the same attachment path.
      cache.attachDevicesRoleRoutes({ resolveComputer: () => routes });
      expect(await list(replacement, 'present_user')).toMatchObject({ ok: false, errorCode: 'target_unsupported' });
      // The devices role's families are one owned set: the native-view browser imports ride with it.
      expect(replacement.hasHandler(RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES)).toBe(true);
      // Stopping the role withdraws the whole set from the live transport and from later replays.
      cache.attachDevicesRoleRoutes(null);
      expect(replacement.hasHandler(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE)).toBe(false);
      expect(replacement.hasHandler(RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES)).toBe(false);
      expect(attach().hasHandler(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE)).toBe(false);
    } finally {
      for (const client of clients) client.shutdown();
      await routes.dispose();
    }
  });

  it('keeps process reads reachable with the same ownership view after the exact machine transport is replaced', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const { createMachineProcessesView } = await import('./processes/view/createMachineProcessesView');
    const fixture = await createLinuxVitalsFixture();
    const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: fixture.root }),
      historyStore: await createMinuteHistoryStore({ directory: join(fixture.root, 'process-history') }) });
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', selfPid: 10, platform: 'win32',
      listRoots: snapshot => snapshot.rows.filter(row => row.pid === 10 || row.pid === 20).map(row => ({
        owner: row.pid === 10 ? { kind: 'happier' as const } : { kind: 'session' as const, sessionId: 'session' },
        pid: row.pid, start: row.start, live: true, ownerCreatedAtMs: 0,
      })),
      // The native OS helper is the boundary; census decoding, ownership and projection stay real.
      censusDependencies: { platform: 'win32', selfPid: 10, helperExecutablePath: '/fixture-helper',
        execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 4,
          rows: [{ pid: 10, ppid: 1, name: 'happier' }, { pid: 20, ppid: 10, name: 'session-runner' },
            { pid: 21, ppid: 20, name: 'tool' }].map(row => ({ ...row, start: { startTimeMs: row.pid },
              principal: { kind: 'sid', value: 'self' }, memory: { bytes: row.pid, kind: 'private' }, cpuTimeUs: 0 })) }) }),
      },
    });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    const view = createMachineProcessesView({ processOwnershipRuntime: ownership, leftBehind, machineVitals: sampler,
      platform: 'win32', selfPid: 10, allProcessesVisible: () => false,
      requesterForOwner: () => ({ accountId: 'owner', displayName: 'Owner' }) });
    let machineId = 'first-machine';
    const routes = { view, target: () => ({ serverId: 'home', machineId, installationId: 'install', custodianAccountId: 'owner' }) };
    let active: { registerMachineProcessesRoutes: (value: typeof routes) => void } | null = null;
    const cache = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => active as never });
    const makeTransport = async () => {
      const { registerDaemonProcessesRpcHandlers } = await import('@/rpc/handlers/daemonProcesses');
      const handlers: RpcHandlerMap = new Map();
      const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
      // The Machine transport is the boundary; replacement still installs and invokes the real receiving handlers.
      const transport = { registerMachineProcessesRoutes(value: typeof routes) { registerDaemonProcessesRpcHandlers(registrar, value); } };
      return { handlers, transport };
    };
    const context = (): RpcHandlerContext => ({ signal: new AbortController().signal,
      machineAdmission: { machineId, installationId: 'install', custodianAccountId: 'owner', actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true });
    try {
      cache.attachMachineProcessesRoutes(routes);
      const first = await makeTransport();
      active = first.transport;
      cache.attachApiMachineForSessions(first.transport as never);
      const read = async (handlers: RpcHandlerMap) => MachineProcessesAnswerV1Schema.parse(
        await handlers.get(RPC_METHODS.MACHINES_PROCESSES_LIST)!({ serverId: 'home', machineId }, context()));
      const before = await read(first.handlers);
      expect(before.owners.find(owner => owner.owner.kind === 'session')?.totals).toMatchObject({ processCount: 2, memoryBytes: 41 });
      machineId = 'replacement-machine';
      const replacement = await makeTransport();
      active = replacement.transport;
      cache.attachApiMachineForSessions(replacement.transport as never);
      const after = await read(replacement.handlers);
      expect(after.machineId).toBe('replacement-machine');
      expect(after.owners).toEqual(before.owners);
      await expect(replacement.handlers.get(RPC_METHODS.MACHINES_PROCESSES_LIST)!({ machineId: 'first-machine' }, context()))
        .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    } finally {
      view.dispose();
      leftBehind.dispose();
      await sampler.stop();
      await fixture.cleanup();
    }
  });
  it('retains sampled vitals while a replacement transport resolves the current machine identity', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const fixture = await createLinuxVitalsFixture();
    const sampler = createMachineVitalsSampler({
      readers: createLinuxMachineVitalsReader({ root: fixture.root }),
      historyStore: await createMinuteHistoryStore({ directory: join(fixture.root, 'history') }),
    });
    try {
      await sampler.start();
      let machineId = 'first-machine';
      const routes: DaemonMachineVitalsRoutes = { sampler, target: () => ({
        serverId: 'server', machineId, installationId: 'installation', custodianAccountId: 'account',
      }) };
      // The transport registrar is an external RPC boundary; the sampler and reader remain real.
      const installed: { routes: DaemonMachineVitalsRoutes | null } = { routes: null };
      const readInstalledRoutes = () => installed.routes;
      const replacement = { registerMachineVitalsRoutes: (next: DaemonMachineVitalsRoutes) => { installed.routes = next; } };
      const cache = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => null });
      cache.attachMachineVitalsRoutes(routes);
      cache.attachApiMachineForSessions(replacement as never);
      expect(readInstalledRoutes()?.sampler.latest()?.memory).toMatchObject({ reported: true, usedBytes: 61_440_000 });
      machineId = 'replacement-machine';
      installed.routes = null;
      cache.attachApiMachineForSessions(replacement as never);
      expect(readInstalledRoutes()?.target()?.machineId).toBe('replacement-machine');
      expect(readInstalledRoutes()?.sampler.latest()).toEqual(sampler.latest());
    } finally {
      await sampler.stop();
      await fixture.cleanup();
    }
  });
  it('keeps the same pool selection owner available after replacing the machine transport', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const request = { machineId: 'machine', group: { service: { pluginId: 'example.accounts', localId: 'service' }, groupId: 'pool' } };
    const projection = ConnectedServicePoolSelectionGetResponseV1Schema.parse({
      group: request.group, observedAtMs: 1_000,
      selection: { selected: null, reason: 'manual_strategy', excluded: [], decisionTrace: {
        activeProfileId: 'account', reason: 'manual_strategy', strategy: 'manual', selectionBasis: 'manual_strategy',
        sticky: false, orderedEligibleCandidates: [], candidates: [],
      } },
    });
    const read = async () => projection;
    const unattached = async () => { throw new Error('pool selection owner is not attached'); };
    let installed: ConnectedServicePoolSelectionRead = unattached;
    const replacement = { registerConnectedServicePoolSelectionRead: (next: ConnectedServicePoolSelectionRead) => { installed = next; } };
    const cache = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => null });
    cache.attachConnectedServicePoolSelectionRead(read);
    cache.prepareApiMachineForSessions(replacement as never);
    expect(await installed(request)).toEqual(projection);
    installed = unattached;
    cache.attachApiMachineForSessions(replacement as never);
    expect(await installed(request)).toEqual(projection);
  });
  it('caches local-service and simulator routes when machine RPC becomes available later', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const localServicesPreview = { getSnapshot: vi.fn() };
    const localServices = {
      localServicesInventory: { getSnapshot: vi.fn(), refreshSnapshot: vi.fn() },
      localServicesLauncher: { getSnapshot: vi.fn(), startTarget: vi.fn() },
      localServicesPreview,
      localServicesActions: { execute: vi.fn() },
    };
    const simulatorPreview = { getSnapshot: vi.fn(), dispatchAction: vi.fn() };
    let apiMachineForSessions: null | {
      registerLocalServicesPreviewRoutes: ReturnType<typeof vi.fn>;
      registerLocalServicesRoutes: ReturnType<typeof vi.fn>;
      replaceDevicesRoleRoutes: ReturnType<typeof vi.fn>;
    } = null;
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    });

    cache.attachLocalServicesPreviewRoutes(localServicesPreview as never);
    cache.attachLocalServicesRoutes(localServices as never);
    cache.attachDevicesRoleRoutes({ simulatorPreview: simulatorPreview as never });

    apiMachineForSessions = {
      registerLocalServicesPreviewRoutes: vi.fn(),
      registerLocalServicesRoutes: vi.fn(),
      replaceDevicesRoleRoutes: vi.fn(),
    };
    cache.attachApiMachineForSessions(apiMachineForSessions as never);

    expect(apiMachineForSessions.registerLocalServicesPreviewRoutes).toHaveBeenCalledWith(localServicesPreview);
    expect(apiMachineForSessions.registerLocalServicesRoutes).toHaveBeenCalledWith({
      localServicesInventory: localServices.localServicesInventory,
      localServicesLauncher: localServices.localServicesLauncher,
      localServicesActions: localServices.localServicesActions,
    });
    expect(apiMachineForSessions.replaceDevicesRoleRoutes).toHaveBeenCalledWith({ simulatorPreview });
  });

  it('caches the connected-account daemon runtime and reattaches it to a replacement machine client', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const runtime: import('./connectedServices/ConnectedAccountDaemonRuntime').ConnectedAccountDaemonRuntime = {
      execute: vi.fn(),
      control: vi.fn(),
    };
    let apiMachineForSessions: null | {
      registerConnectedAccountDaemonRuntime: ReturnType<typeof vi.fn>;
      registerConnectedAccountPurposeBindingRuntime: ReturnType<typeof vi.fn>;
    } = null;
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    }) as unknown as {
      attachConnectedAccountDaemonRuntime(
        connectedAccountRuntime: import('./connectedServices/ConnectedAccountDaemonRuntime').ConnectedAccountDaemonRuntime,
      ): void;
      attachApiMachineForSessions(apiMachine: typeof apiMachineForSessions): void;
    };

    cache.attachConnectedAccountDaemonRuntime(runtime);
    apiMachineForSessions = {
      registerConnectedAccountDaemonRuntime: vi.fn(),
      registerConnectedAccountPurposeBindingRuntime: vi.fn(),
    };
    cache.attachApiMachineForSessions(apiMachineForSessions);

    expect(apiMachineForSessions.registerConnectedAccountDaemonRuntime)
      .toHaveBeenCalledWith(runtime);
  });

  it('attaches the Connected Account Action-form purpose producer before and after machine replacement', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const runtime = {
      activatePurposeBindings: vi.fn(),
      listActionFormConnectedAccountOptions: vi.fn(),
    };
    let apiMachineForSessions: null | {
      registerConnectedAccountDaemonRuntime: ReturnType<typeof vi.fn>;
      registerConnectedAccountPurposeBindingRuntime: ReturnType<typeof vi.fn>;
    } = null;
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    }) as unknown as {
      attachConnectedAccountPurposeBindingRuntime(value: typeof runtime): void;
      attachApiMachineForSessions(apiMachine: typeof apiMachineForSessions): void;
    };

    cache.attachConnectedAccountPurposeBindingRuntime(runtime);
    apiMachineForSessions = {
      registerConnectedAccountDaemonRuntime: vi.fn(),
      registerConnectedAccountPurposeBindingRuntime: vi.fn(),
    };
    cache.attachApiMachineForSessions(apiMachineForSessions);

    expect(apiMachineForSessions.registerConnectedAccountPurposeBindingRuntime)
      .toHaveBeenCalledWith(runtime);
  });

  it('lets the combined local-services route family own preview when it arrives first', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const apiMachineForSessions = {
      registerLocalServicesPreviewRoutes: vi.fn(),
      registerLocalServicesRoutes: vi.fn(),
      replaceDevicesRoleRoutes: vi.fn(),
    };
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    });
    const preview = { getSnapshot: vi.fn() };
    const localServices = {
      localServicesInventory: { getSnapshot: vi.fn(), refreshSnapshot: vi.fn() },
      localServicesLauncher: { getSnapshot: vi.fn(), startTarget: vi.fn() },
      localServicesPreview: preview,
      localServicesActions: { execute: vi.fn() },
    };

    cache.attachLocalServicesRoutes(localServices as never);
    cache.attachLocalServicesPreviewRoutes(preview as never);

    expect(apiMachineForSessions.registerLocalServicesRoutes).toHaveBeenCalledWith(localServices);
    expect(apiMachineForSessions.registerLocalServicesPreviewRoutes).not.toHaveBeenCalled();
  });
});
