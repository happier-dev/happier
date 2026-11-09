import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { ApiMachineClient } from '@/api/apiMachine';
import { createMachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { MachineProcessesGetResultV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { RpcHandlerContext, RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '@/daemon/processes/leftBehind/leftBehindPass';
import { createProcessActionExecutor } from '@/daemon/processes/actions/processActionExecutor';
import { createMachineProcessesView } from '@/daemon/processes/view/createMachineProcessesView';
import { registerDaemonProcessesRpcHandlers } from '@/rpc/handlers/daemonProcesses';
import { createLinuxVitalsFixture } from '@/daemon/vitals/readers/linux.testkit';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { processRef } from '@/daemon/processes/view/processRef';
import { join } from 'node:path';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { createMachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import { createActivityLog } from '@/daemon/guard/activityLog';
import { createGuardRuntime } from '@/daemon/guard/guardRuntime';
import { createGuardWatch } from '@/daemon/guard/view/guardWatch';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { requestSessionInputLiveWork, SessionInputLiveWorkSchema } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { createDeferred } from '@/testkit/async/deferred';
import type { TrackedSession } from '@/daemon/types';
import { createDaemonStorageRoutes } from '@/rpc/handlers/storage';
import { createStoragePolicyFixture } from '@/storage/storagePolicy.testkit';

const io = vi.hoisted(() => vi.fn());
// HTTP and Socket.IO are genuine boundaries; Action routing, exact targeting and codecs stay real.
vi.mock('socket.io-client', () => ({ io }));

const responses: unknown[] = [];
const requests: { method: string; params: unknown }[] = [];
let releaseHome = () => {};
let receive: ((method: string, params: unknown) => Promise<unknown>) | undefined;
const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
const params = { token: credentials.token, credentials, sessionId: 'cli-global', serverId: 'home',
  serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null } as const;

describe('CLI machine Processes Action transport', () => {
  beforeEach(() => {
    responses.length = 0;
    requests.length = 0;
    receive = undefined;
    releaseHome = publishServerHttpRuntimeOrigin('https://home.invalid', 'https');
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (!path.startsWith('/v1/machines/')) throw new Error(`Unexpected HTTP read: ${path}`);
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { machine: { id: decodeURIComponent(path.slice('/v1/machines/'.length)),
          storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    bindApiSessionSocketMock(io, createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
        || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
        throw new Error('Unexpected Machine RPC boundary request');
      }
      requests.push({ method: payload.method, params: payload.params });
      if (receive) return receive(payload.method, payload.params).then(result => ({ ok: true, result }));
      if (!responses.length) throw new Error(`Unexpected Machine RPC: ${payload.method}`);
      return { ok: true, result: responses.shift() };
    } }));
  });
  afterEach(() => { releaseHome(); vi.restoreAllMocks(); });

  it('routes safe service reads and watch intent to the exact Machine through the real CLI factory', async () => {
    const machine = { serverId: 'home', machineId: 'selected' };
    const actions = [
      ['machines.services.list', machine],
      ['machines.services.discovery', machine],
      ['machines.services.detail', { ...machine, serviceId: 'service', expectedGeneration: 'generation' }],
      ['machines.services.watch', { ...machine, candidateId: 'candidate', expectedRevision: 'native', lifecyclePurpose: 'development' }],
      ['machines.services.unwatch', { ...machine, watchId: 'watch', expectedRevision: 'watches' }],
    ] as const;
    const executor = createCliActionExecutor(params);
    for (const [actionId, input] of actions) {
      responses.push({ kind: 'unavailable', reason: 'denied' });
      expect(await executor.execute(actionId, input, context))
        .toEqual({ ok: true, result: { kind: 'unavailable', reason: 'denied' } });
    }
    expect(requests.map(request => request.method)).toEqual(actions.map(([actionId]) => `selected:${actionId}`));
    expect(await executor.execute('machines.services.list', { ...machine, serverId: 'another-home' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(requests).toHaveLength(actions.length);
  });

  it('consumes the installed service owner locally and retains RPC for a different Machine', async () => {
    const localInputs: unknown[] = [];
    const executor = createCliActionExecutor({ ...params,
      machineActionDirectTargetTransport: Object.assign({ machineId: 'selected', invoke: async () => {
        throw new Error('A local service Action must not re-enter its Machine RPC dispatcher');
      } }, { machineServiceAction: async (request: { input: unknown }) => {
        localInputs.push(request.input);
        return { kind: 'unavailable', reason: 'denied' };
      } }),
    });
    const local = { serverId: 'home', machineId: 'selected' };
    expect(await executor.execute('machines.services.list', local, context))
      .toEqual({ ok: true, result: { kind: 'unavailable', reason: 'denied' } });
    expect(localInputs).toEqual([local]);
    expect(requests).toHaveLength(0);
    responses.push({ kind: 'snapshot', services: [] });
    expect(await executor.execute('machines.services.list', { ...local, machineId: 'remote' }, context))
      .toEqual({ ok: true, result: { kind: 'snapshot', services: [] } });
    expect(localInputs).toEqual([local]);
    expect(requests.map(request => request.method)).toEqual(['remote:machines.services.list']);
    const unavailable = createCliActionExecutor({ ...params, machineActionDirectTargetTransport: {
      machineId: 'selected', invoke: async () => { throw new Error('An unavailable local owner must not dispatch RPC'); },
    } });
    expect(await unavailable.execute('machines.services.list', local, context))
      .toEqual({ ok: true, result: { kind: 'unavailable', reason: 'admission_unavailable' } });
    expect(requests.map(request => request.method)).toEqual(['remote:machines.services.list']);
  });

  it('mints Environment read facts only from the captured Account deployment response', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'environment-reader' })).toString('base64url')}.signature`;
    const http = vi.spyOn(axios, 'request');
    const response = { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    http.mockResolvedValueOnce({ ...response, data: { ok: false, error: 'deployment_access_denied' } });
    http.mockResolvedValueOnce({ ...response, data: { ok: true, items: [{ environmentId: 'private-environment', read: true, deploy: false }] } });
    const facts: boolean[] = [];
    const requesterIds: (string | null | undefined)[] = [];
    const executor = createCliActionExecutor({ ...params, token, credentials: { token, encryption: null },
      machineActionDirectTargetTransport: { machineId: 'selected', invoke: async () => {
        throw new Error('The local service owner must not re-enter RPC');
      }, machineServiceAction: async (request: { input: unknown; requesterAccountId?: string | null; canReadEnvironments?: (environmentIds: readonly string[]) => Promise<ReadonlySet<string>> }) => {
        if (!request.canReadEnvironments) throw new Error('Captured Environment read fact is missing');
        requesterIds.push(request.requesterAccountId);
        facts.push((await request.canReadEnvironments(['private-environment'])).has('private-environment'));
        return { kind: 'snapshot', services: [] };
      } },
    });
    for (let index = 0; index < 2; index++) expect(await executor.execute('machines.services.list', {
      serverId: 'home', machineId: 'selected',
    }, context)).toEqual({ ok: true, result: { kind: 'snapshot', services: [] } });
    expect(facts).toEqual([false, true]);
    expect(requesterIds).toEqual(['environment-reader', 'environment-reader']);
    expect(http.mock.calls).toHaveLength(2);
    for (const [request] of http.mock.calls) {
      expect(new URL(request.url!).origin).toBe('https://home.invalid');
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://home.invalid/v1/deployments/environments/access');
      expect(request.data).toEqual({ serverId: 'home', environmentIds: ['private-environment'] });
      expect(request.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    }
  });

  it.each(['vitals', 'policy', 'guard', 'processes', 'storage'] as const)('admits %s through the real CLI executor and ApiMachine routes despite a local shortcut', async family => {
    const fixture = await createLinuxVitalsFixture();
    const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: fixture.root }),
      historyStore: await createMinuteHistoryStore({ directory: join(fixture.root, 'history') }) });
    let metadata: Record<string, unknown> = MachinePublishedMetadataV1Schema.parse({ host: 'fixture', platform: 'linux',
      happyCliVersion: '0.3.0', homeDir: fixture.root, happyHomeDir: fixture.root });
    let revision = 1;
    if (family === 'policy') {
      vi.mocked(axios.get).mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        const data = path === '/v1/account/encryption'
          ? AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 0 })
          : path === '/v1/machines/selected' ? { machine: MachinePublishedRowV1Schema.parse({ id: 'selected', storageMode: 'plain',
            metadata: encodePlainMachineStoredContent(metadata), metadataVersion: revision, daemonState: null, daemonStateVersion: 0,
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }) } : null;
        if (!data) throw new Error(`Unexpected policy HTTP read: ${path}`);
        return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data };
      });
    }
    // The Account metadata CAS is the persistence/network boundary. Its real policy
    // normalization, writer, CLI execution and receiving RPC admission stay composed.
    const policy = createMachineResourcesPolicyRuntime({ port: {
      read: async () => ({ status: 'ready', metadata, metadataVersion: revision }),
      compareAndSwap: async input => { metadata = input.metadata; return { status: 'applied', metadata, metadataVersion: ++revision }; },
    } });
    const api = new ApiMachineClient(credentials.token, { id: 'selected', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const identity = { serverId: 'home', machineId: 'selected', installationId: 'install', custodianAccountId: 'custodian' };
    api.registerMachineVitalsRoutes({ sampler, target: () => identity });
    api.registerMachineResourcesPolicyRoutes({ policy, target: () => identity });
    await policy.reload();
    const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
    const activity = await createActivityLog({ activeServerDir: fixture.root, resourceSummary: summary });
    // The native census is an OS boundary; run the real census parser and ownership beneath it.
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', platform: 'darwin',
      listRoots: snapshot => snapshot.rows.map(row => ({ owner: { kind: 'happier' as const }, pid: row.pid, start: row.start,
        live: true, ownerCreatedAtMs: 0 })),
      censusDependencies: { platform: 'darwin', helperExecutablePath: '/fixture-helper',
        execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 4,
          rows: [{ pid: process.pid, ppid: 1, pgid: process.pid, name: 'daemon',
            start: { startTimeMs: 1, native: 'darwin-proc:1:0:1' }, principal: { kind: 'uid', value: '501' },
            memory: { bytes: 1024, kind: 'rss' }, cpuTimeUs: 0 }] }) }) } });
    const retiredActivity = createDeferred<unknown>();
    const retiredRequest = createDeferred();
    let observedSessions: TrackedSession[] = [];
    const sessionActivity = createSessionLiveWorkProducer({ readSessions: () => observedSessions,
      // This fixture withholds one remote runner response, keeping the real Session
      // decoder, inventory, Guard projection, registration and Action executor composed.
      readActivity: () => requestSessionInputLiveWork({ callRpc: async () => {
        retiredRequest.resolve();
        return await retiredActivity.promise;
      } }) });
    const inventory = createManagedActivityInventory({ producers: family === 'guard' ? [sessionActivity] : [] });
    const readFacts = async () => ({ ownership: await ownership.readOwners({ freshness: 'fresh' }),
      inventory: await inventory.read(), targets: [] });
    const readPolicy = () => {
      const current = policy.read();
      if (current.status !== 'ready') throw new Error('Policy unavailable');
      return current.policy.guard;
    };
    const runtime = createGuardRuntime({ vitals: sampler, readPolicy, subscribePolicy: policy.subscribe, subscribe: inventory.subscribe,
      readFacts, activity, stop: async () => { throw new Error('No stop target in this fixture'); }, notice: async () => false,
      notifyEpisode: async () => {}, onError: error => { throw error; } });
    const guard = createGuardWatch({ policy, sampler, ownership, readFacts, readTarget: () => identity, activityLog: activity,
      sessionState: runtime, readState: () => ({ v: 1, capabilities: { memoryPressure: { status: 'available' },
        ceiling: { status: 'unavailable', reason: 'no_user_manager' }, keepAwake: { modes: ['off', 'on', 'on_power'] } },
        keepAwakeHolding: false }), readLeftBehind: () => ({ count: 0, footprintBytes: 0 }), subscribe: runtime.subscribe });
    api.registerMachineGuardRoutes({ target: () => identity, guard, activity,
      keepRunning: async input => ({ status: await runtime.keepRunning(input.sessionId ?? '') }) });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    const processes = createMachineProcessesView({ processOwnershipRuntime: ownership, leftBehind, machineVitals: sampler,
      platform: 'darwin', allProcessesVisible: () => false,
      requesterForOwner: () => ({ accountId: identity.custodianAccountId, displayName: 'Custodian' }) });
    api.registerMachineProcessesRoutes({ view: processes, target: () => identity });
    const storage = createDaemonStorageRoutes({ target: () => identity,
      deps: async () => ({ resourcesPolicy: await createStoragePolicyFixture(), catalog: { happyHomeDir: fixture.root, activeServerDir: fixture.root }, readVolumes: () => [] }),
      readOwnSessionIds: () => new Set() });
    api.registerStorageRoutes(storage);
    // The canonical heterogeneous transport registry represents authenticated ingress.
    // Use the registrations installed by ApiMachine, not a test-owned method map.
    const handlers: RpcHandlerMap = Reflect.get(Reflect.get(api, 'rpcHandlerManager'), 'handlers');
    let admitted: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { ...identity, actorAccountId: 'custodian', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    let delayGuardRead = family === 'guard';
    receive = async (method, input) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Missing installed machine resource route: ${method}`);
      if (delayGuardRead && method === `selected:${RPC_METHODS.MACHINES_GUARD_GET}`) {
        delayGuardRead = false;
        // A valid composed census/Session read can exceed the generic 20-second RPC acknowledgement budget.
        await new Promise(resolve => setTimeout(resolve, 20_050));
      }
      return handler(input, admitted);
    };
    const executor = createCliActionExecutor({ ...params,
      // The actual local ingress carries no Machine admission, exactly as in D1.
      machineActionDirectTargetTransport: { machineId: 'selected', invoke: (method, input, options) =>
        api.invokeLocalMachineAction(method, input, options) } });
    try {
      await sampler.start();
      if (family === 'vitals') {
        const vitals = await executor.execute('machines.vitals.get', { machineId: 'selected', view: 'summary' }, context);
        expect(vitals, JSON.stringify(vitals)).toMatchObject({ ok: true });
        if (!vitals.ok) throw new Error(vitals.error);
        assertActionOutputContract('machines.vitals.get', vitals.result);
        expect(vitals.result).toMatchObject({ state: 'reporting', sample: { memory: { totalBytes: 102_400_000, availableBytes: 40_960_000 } } });
        const history = await executor.execute('machines.vitals.history.get', { machineId: 'selected', range: '1h' }, context);
        expect(history.ok).toBe(true);
        if (!history.ok) throw new Error(history.error);
        assertActionOutputContract('machines.vitals.history.get', history.result);
        expect(history.result).toMatchObject({ range: '1h', today: { rxBytes: 0, txBytes: 0 } });
        expect(requests.map(request => request.method)).toEqual([
          `selected:${RPC_METHODS.MACHINES_VITALS_GET}`, `selected:${RPC_METHODS.MACHINES_VITALS_HISTORY_GET}`,
        ]);
      }
      if (family === 'policy') {
        const initial = await executor.execute('machines.resources.policy.get', { machineId: 'selected' }, context);
        expect(initial, JSON.stringify(initial)).toMatchObject({ ok: true, result: { status: 'ready', revision: 1 } });
        if (!initial.ok) throw new Error(initial.error);
        assertActionOutputContract('machines.resources.policy.get', initial.result);
        const saved = await executor.execute('machines.resources.policy.set', { machineId: 'selected', expectedRevision: 1,
          patch: { processes: { allProcessesVisible: true }, guard: { keepAwake: 'off' } } }, context);
        expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
        if (!saved.ok) throw new Error(saved.error);
        assertActionOutputContract('machines.resources.policy.set', saved.result);
        expect(saved.result).toMatchObject({ status: 'applied', revision: 2,
          policy: { processes: { allProcessesVisible: true }, guard: { keepAwake: 'off' } } });
        const acknowledged = policy.read();
        expect(acknowledged.status).toBe('ready');
        if (acknowledged.status !== 'ready') throw new Error('Acknowledged policy unavailable');
        expect(MachineResourcesPolicyV1Schema.parse(metadata.resourcesPolicyV1)).toEqual(acknowledged.policy);
        const reread = await executor.execute('machines.resources.policy.get', { machineId: 'selected' }, context);
        expect(reread).toMatchObject({ ok: true, result: { status: 'ready', revision: 2,
          policy: { processes: { allProcessesVisible: true }, guard: { keepAwake: 'off' } } } });
        if (!reread.ok) throw new Error(reread.error);
        assertActionOutputContract('machines.resources.policy.get', reread.result);
        admitted = { ...admitted, machineAdmission: { ...identity, actorAccountId: 'recipient', role: 'use', encryptionMode: 'plain' } };
        const denied = await executor.execute('machines.resources.policy.set', { machineId: 'selected', expectedRevision: 2,
          patch: { guard: { keepAwake: 'on' } } }, context);
        expect(denied).toMatchObject({ ok: false });
        expect(revision).toBe(2);
        expect(MachineResourcesPolicyV1Schema.parse(metadata.resourcesPolicyV1).guard.keepAwake).toBe('off');
        expect(requests.map(request => request.method)).toEqual([
          `selected:${RPC_METHODS.MACHINES_RESOURCES_POLICY_SET}`, `selected:${RPC_METHODS.MACHINES_RESOURCES_POLICY_SET}`,
        ]);
      }
      if (family === 'guard') {
        const view = await executor.execute('machines.guard.get', { machineId: 'selected' }, context);
        expect(view, JSON.stringify(view)).toMatchObject({ ok: true });
        if (!view.ok) throw new Error(view.error);
        assertActionOutputContract('machines.guard.get', view.result);
        expect(view.result).toMatchObject({ policy: { keepAwake: 'on' }, leftBehind: { count: 0 } });
        const listed = await executor.execute('machines.guard.activity.list', { machineId: 'selected', range: 'today' }, context);
        expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
        if (!listed.ok) throw new Error(listed.error);
        assertActionOutputContract('machines.guard.activity.list', listed.result);
        const kept = await executor.execute('machines.guard.idleStop.keepRunning', { machineId: 'selected', sessionId: 'no-warning' }, context);
        expect(kept).toEqual({ ok: true, result: { status: 'not_pending' } });
        assertActionOutputContract('machines.guard.idleStop.keepRunning', kept.ok ? kept.result : null);
        observedSessions = [{ pid: 42, startedBy: 'daemon', happySessionId: 'retired-session' }];
        sessionActivity.notifyChanged();
        const retiredRead = inventory.read();
        await retiredRequest.promise;
        observedSessions = [];
        sessionActivity.notifyChanged();
        let agentView: Awaited<ReturnType<typeof executor.execute>> | undefined;
        const agentRead = executor.execute('machines.guard.get', { machineId: 'selected' },
          { ...context, surface: 'agent', authority: 'account_automation' }).then(result => { agentView = result; });
        try {
          await vi.waitFor(() => expect(agentView).toMatchObject({ ok: true }), { timeout: 1_000 });
        } finally {
          retiredActivity.resolve(SessionInputLiveWorkSchema.parse({ session: 'unknown', input: 'unknown' }));
          await retiredRead;
          await agentRead;
        }
        expect(agentView, JSON.stringify(agentView)).toMatchObject({ ok: true, result: { policy: { keepAwake: 'on' } } });
        if (!agentView?.ok) throw new Error(agentView?.error ?? 'Guard Action did not settle');
        assertActionOutputContract('machines.guard.get', agentView.result);
        admitted = { ...admitted, verifyMachineAdmissionCurrent: async () => false };
        expect(await executor.execute('machines.guard.get', { machineId: 'selected' }, context)).toMatchObject({ ok: false });
        expect(requests.map(request => request.method)).toEqual([
          `selected:${RPC_METHODS.MACHINES_GUARD_GET}`, `selected:${RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST}`,
          `selected:${RPC_METHODS.MACHINES_GUARD_IDLE_STOP_KEEP_RUNNING}`, `selected:${RPC_METHODS.MACHINES_GUARD_GET}`,
          `selected:${RPC_METHODS.MACHINES_GUARD_GET}`,
        ]);
      }
      if (family === 'processes' || family === 'storage') {
        const actionId = family === 'processes' ? 'machines.processes.get' : 'machines.storage.scan.get';
        const result = await executor.execute(actionId, { machineId: 'selected', ...(family === 'processes'
          ? { ref: processRef(42, { startTimeMs: 42, native: 'darwin-proc:42:0:42' }) } : {}) }, context);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (!result.ok) throw new Error(result.error);
        assertActionOutputContract(actionId, result.result);
        expect(result.result).toEqual(family === 'processes' ? { row: null } : { state: null, nodes: [], coverage: [] });
        expect(requests.map(request => request.method)).toEqual([`selected:${family === 'processes'
          ? RPC_METHODS.MACHINES_PROCESSES_GET : RPC_METHODS.DAEMON_STORAGE_SCAN_GET}`]);
      }
    } finally {
      storage.dispose(); processes.dispose(); leftBehind.dispose(); guard.dispose(); inventory.dispose(); summary.stop(); policy.stop();
      await api.shutdown(); await sampler.stop(); await fixture.cleanup();
    }
  });

  it('reads a guest process, requires Action confirmation and ends only that reviewed native target', async () => {
    const fixture = await createLinuxVitalsFixture();
    const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: fixture.root }),
      historyStore: await createMinuteHistoryStore({ directory: join(fixture.root, 'history') }) });
    const selfPid = process.pid;
    const owner = { kind: 'session', sessionId: 'guest-session' } as const;
    const rows = new Map([selfPid, 20, 21, 30].map(pid => [pid, { pid, ppid: pid === 21 ? 20 : 1, pgid: pid,
      name: 'tool', start: { startTimeMs: pid, native: `darwin-proc:${pid}:0:${pid}` },
      principal: { kind: 'uid', value: '501' }, memory: { bytes: pid, kind: 'rss' }, cpuTimeUs: 0,
      ...(pid === 21 ? { argv: ['env', 'TOKEN=ordinary-action-secret', 'agent', 'https://alice:ordinary-url-secret@example.test/path'] } : {}),
      ...(pid === 20 || pid === 21 ? { ownerTag: 'v1.123456789abc.session.guest-session' } : {}) }]));
    // Native census and signals are the OS boundary. Ownership, projection, approval and termination stay real.
    const censusDependencies = { platform: 'darwin' as const, selfPid, helperExecutablePath: '/fixture-helper',
      execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 4, rows: [...rows.values()] }) }) };
    const ownership = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', selfPid, platform: 'darwin',
      censusDependencies, listRoots: snapshot => snapshot.rows.filter(row => row.pid === selfPid || row.pid === 20).map(row => ({
        owner: row.pid === selfPid ? { kind: 'happier' as const } : owner, pid: row.pid, start: row.start, live: true, ownerCreatedAtMs: 0,
      })) });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership });
    const requesterForOwner = () => ({ accountId: 'guest', displayName: 'Guest' });
    const view = createMachineProcessesView({ processOwnershipRuntime: ownership, leftBehind, machineVitals: sampler,
      platform: 'darwin', selfPid, allProcessesVisible: () => false, requesterForOwner });
    const signals: number[] = [];
    const actions = createProcessActionExecutor({ ownership, leftBehind, selfPid, platform: 'darwin',
      allProcessesVisible: () => false, requesterForOwner, systemBoundary: { platform: 'darwin', censusDependencies,
        kill(pid) { signals.push(pid); rows.delete(pid); }, async wait() {} } });
    const handlers: RpcHandlerMap = new Map();
    const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    registerDaemonProcessesRpcHandlers(registrar, { view, actions, target: () => ({ serverId: 'home', machineId: 'selected',
      installationId: 'install', custodianAccountId: 'custodian' }) });
    const admitted: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { machineId: 'selected', installationId: 'install', custodianAccountId: 'custodian',
        actorAccountId: 'custodian', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    receive = (method, input) => Promise.resolve(handlers.get(method.slice('selected:'.length))!(input, admitted));
    // Real CLI ingress treats unproven credentials as automation. Decode the
    // canonical stored representation, just as interactive credential ingress does.
    const terminalCredentials = decodeStoredCredentials(encodeStoredCredentials(credentials));
    if (!terminalCredentials) throw new Error('Stored terminal credentials unavailable');
    const executor = createCliActionExecutor({ ...params, credentials: terminalCredentials });
    try {
      const ref = processRef(21, rows.get(21)!.start);
      const read = await executor.execute('machines.processes.get', { machineId: 'selected', ref }, context);
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.error);
      const detail = MachineProcessesGetResultV1Schema.parse(read.result);
      const selected = detail.row;
      expect(detail).toMatchObject({ row: { ref, level: 'proven' }, owner });
      expect(detail.row).toMatchObject({ command: 'env TOKEN=[REDACTED] agent https://[REDACTED]@example.test/path' });
      expect(JSON.stringify(read)).not.toMatch(/ordinary-action-secret|ordinary-url-secret|alice/);
      if (!selected || !('level' in selected)) throw new Error('Expected a Happier process');
      const input = { machineId: 'selected', targets: [{ ref, expect: { level: selected.level, owner } }], tree: false };
      expect(await executor.execute('machines.processes.kill', input, context))
        .toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
      expect(signals).toEqual([]);
      expect(requests).toHaveLength(1);
      const killed = await executor.execute('machines.processes.kill', input,
        { ...context, presentUserConfirmation: { actionId: 'machines.processes.kill' } });
      if (!killed.ok) throw new Error(JSON.stringify(killed));
      expect(killed).toMatchObject({ ok: true, result: { status: 'ended', outcomes: [{ ref, outcome: 'ended' }] } });
      expect(signals).toEqual([21]);
      expect(rows.has(21)).toBe(false);
      expect(rows.has(30)).toBe(true);
      expect(await executor.execute('machines.processes.get', { machineId: 'selected', ref }, context))
        .toEqual({ ok: true, result: { row: null } });
    } finally { view.dispose(); leftBehind.dispose(); await sampler.stop(); await fixture.cleanup(); }
  });

  it('reaches the exact selected machine through authenticated ingress even when a direct transport exists', async () => {
    const invoke = vi.fn(async () => { throw new Error('Unadmitted local transport'); });
    const executor = createActionExecutor(createCliActionDeps({ ...params,
      machineActionDirectTargetTransport: { machineId: 'selected', invoke } }));
    const controller = new AbortController();
    const signal = controller.signal;
    responses.push({ row: null });
    expect(await executor.execute('machines.processes.get', { machineId: 'selected', ref: 'process-ref' },
      { ...context, signal })).toEqual({ ok: true, result: { row: null } });
    expect(requests).toEqual([{ method: `selected:${RPC_METHODS.MACHINES_PROCESSES_GET}`,
      params: { serverId: 'home', machineId: 'selected', ref: 'process-ref' } }]);
    expect(axios.get).toHaveBeenCalledWith('https://home.invalid/v1/machines/selected', expect.objectContaining({
      signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }));
    expect(invoke).not.toHaveBeenCalled();
    // The request owner may compose its lifetime with the caller's signal.
    // Prove cancellation reaches HTTP and prevents RPC/disclosure, rather than requiring object identity.
    vi.mocked(axios.get).mockImplementationOnce(async (_url, config) => {
      const admittedSignal = config?.signal;
      expect(admittedSignal).toBeInstanceOf(AbortSignal);
      if (!(admittedSignal instanceof AbortSignal)) throw new Error('Missing HTTP cancellation');
      expect(admittedSignal.aborted).toBe(false);
      controller.abort(new Error('cancel-process-read'));
      expect(admittedSignal.aborted).toBe(true);
      expect(admittedSignal.reason).toBe(signal.reason);
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { machine: { id: 'selected', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    expect(await executor.execute('machines.processes.get', { machineId: 'selected', ref: 'process-ref' },
      { ...context, signal })).toMatchObject({ ok: false });
    expect(requests).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves receiving Action failure and deferred approval, and rejects malformed process output', async () => {
    const executor = createActionExecutor(createCliActionDeps(params));
    const actionId = 'machines.processes.kill';
    const input = { machineId: 'selected', targets: [{ ref: 'process-ref', expect: { level: 'proven' } }], tree: false };
    const approved = { ...context, presentUserConfirmation: { actionId } } as const;
    const failure = { ok: false, errorCode: 'expectation_changed', error: 'expectation_changed' };
    responses.push(failure);
    expect(await executor.execute(actionId, input, approved)).toEqual(failure);
    const deferred = { kind: 'approval_request_created', actionId, artifactId: 'approval' };
    responses.push(deferred);
    expect(await executor.execute(actionId, input, approved)).toEqual({ ok: true, result: deferred });
    responses.push({ status: 'ended', outcomes: [{ ref: 'process-ref', outcome: 'ended', command: 'private' }] });
    expect(await executor.execute(actionId, input, approved)).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('rejects another Home before transport and rechecks retired credentials after the response', async () => {
    let current = true;
    const executor = createActionExecutor(createCliActionDeps({ ...params, isCredentialCurrent: async () => current }));
    expect(await executor.execute('machines.processes.get', { serverId: 'other', machineId: 'selected', ref: 'process-ref' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(requests).toEqual([]);
    vi.mocked(axios.get).mockImplementationOnce(async () => {
      current = false;
      return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
        data: { machine: { id: 'selected', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
    });
    responses.push({ row: null });
    expect(await executor.execute('machines.processes.get', { machineId: 'selected', ref: 'process-ref' }, context))
      .toMatchObject({ ok: false, errorCode: 'action_failed', error: 'scope-retired' });
  });
});
