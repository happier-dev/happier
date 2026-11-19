import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter, AxiosRequestConfig } from 'axios';
import { mkdir, rmdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createMemoryProcessBoundary as createProcessBoundary } from './processMemoryIndexer.testkit';
import { applyMemoryIndexerPublication, type MemoryHintCommit, type MemoryHintRun, type MemoryIndexerConnection, type MemoryIndexerHost,
  type MemoryIndexerPublication, type MemoryIndexerSnapshot } from './memoryIndexerBoundary';
import type { MemorySettingsV1 } from '@/settings/memorySettings';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { BackgroundServiceProcessPluginHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBootstrap';
import type { AdmittedBackgroundServicePlugin } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo, httpFixture } = vi.hoisted(() => ({ mockIo: vi.fn(), httpFixture: {
  handlers: new Map<string, (url: string, config: AxiosRequestConfig) => Promise<Readonly<{ status: number; data: unknown }>>>(),
  restore: () => {},
} }));
vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  const original = actual.default.defaults.adapter;
  // Keep real clients, request encoding and interceptors. The OS HTTP adapter
  // must be installed before modules capture their own axios.create clients.
  const adapter: AxiosAdapter = async config => {
    const url = actual.default.getUri(config);
    if (new URL(url).origin !== 'https://api.example.test') return await actual.default.getAdapter(original)(config);
    const authorization = config.headers.get('Authorization');
    const handler = typeof authorization === 'string' ? httpFixture.handlers.get(authorization) : undefined;
    const methodBound = config.method === 'get'
      || config.method === 'post' && ['/v1/account/project-rows/list', '/v2/sessions/read-batch'].includes(new URL(url).pathname);
    if (!handler || !methodBound) throw new Error('Unbound Memory startup HTTP fixture request');
    const response = await handler(url, config);
    return { ...response, config, headers: {}, statusText: 'fixture' };
  };
  actual.default.defaults.adapter = adapter;
  httpFixture.restore = () => { actual.default.defaults.adapter = original; httpFixture.handlers.clear(); };
  return actual;
});

afterAll(() => { httpFixture.restore(); });

// Transform the real child graph outside each operation's deadline.
await import('./processMemoryIndexer');
await import('./memoryIndexerServiceEntry');
await import('./memoryWorker');
await import('@/api/apiMachine');
await import('../machine/bootstrapMachineSyncRuntime');
await import('../startup/createDaemonMachineBootstrapRuntime');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function expireChildGrace() {
  // Let the settled operation's bridge replies admit the child's idle grace,
  // then fire that exact owner deadline. No wall-time timeout is increased.
  await new Promise<void>(resolve => { setImmediate(resolve); });
  await vi.advanceTimersByTimeAsync(57_000);
}

describe('Memory process placement composition', () => {
  const env = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_LOG_LEVEL', 'HAPPY_ENABLE_V2_CHANGES']);
  let home: string;
  const connections: MemoryIndexerConnection[] = [];
  beforeEach(async () => {
    home = await createTempDir('memory-process-composed-');
    applyEnvValues({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });
  afterEach(async () => {
    for (const connection of connections.splice(0)) await connection.retire();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreEnvValues(env);
    vi.resetModules();
    await removeTempDir(home);
  });

  it.each(['complete', 'stop'] as const)('connects core Machine control while initial Memory policy waits, without exposing or losing Memory work (%s)', async ending => {
    vi.useRealTimers();
    applyEnvValues({ HAPPY_ENABLE_V2_CHANGES: 'false' });
    const { ApiClient } = await import('@/api/api');
    const { ApiMachineClient } = await import('@/api/apiMachine');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
    const { FeaturesResponseSchema, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1 } = await import('@happier-dev/protocol');
    const { bootstrapMachineSyncRuntime } = await import('../machine/bootstrapMachineSyncRuntime');
    const { createDaemonMachineBootstrapRuntime } = await import('../startup/createDaemonMachineBootstrapRuntime');
    const { createCliRegistryHostV1 } = await import('@/registries/createCliRegistryHost');
    const { createDaemonServerWorkScheduler, createDaemonServerWorkBudget } = await import('../serverWork');
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const { memoryIndexPolicyKey, resolveMemoryIndexPolicy } = await import('./transcript/coveragePolicy');
    const { createSessionRecordFixture, createCompactSessionListRowFixture, createSessionReadBatchResponseFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const processChannel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
    const { configuration } = await import('@/configuration');
    const { waitForObservation } = await import('@/api/client/accountEncryptionCurrentnessObservation');
    const priorDaemon = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: false });
    const savedSettings = await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, indexMode: 'deep', deleteOnDisable: false,
      embeddings: { ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'disabled' } });
    const paths = resolveMemoryIndexPaths();
    await mkdir(dirname(paths.tier1DbPath), { recursive: true });
    const seed = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
    seed.trySeedSessionCursorsIfMissing({ sessionId: 'retained-before-connect', nowMs: 1, lastHintedSeq: 0, lastDeepIndexedSeq: 0 });
    seed.close();
    const deep = openDeepIndexDb({ dbPath: paths.deepDbPath });
    deep.init();
    deep.insertChunk({ sessionId: 'retained-before-connect', seqFrom: 1, seqTo: 2,
      createdAtFromMs: 1, createdAtToMs: 2, text: 'retained searchable marker',
      policyKey: memoryIndexPolicyKey(resolveMemoryIndexPolicy(savedSettings)) });
    expect(deep.search({ query: 'retained', scope: { type: 'global' }, maxResults: 5 })).toHaveLength(1);
    deep.close();
    const retained = createSessionRecordFixture({ id: 'retained-before-connect', encryptionMode: 'plain',
      metadata: JSON.stringify(createTestMetadata({ machineId: 'memory-startup-machine' })) });
    const entered = deferred();
    const release = deferred();
    let held = true;
    const boundary = createProcessBoundary();
    vi.spyOn(processChannel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
    const axios = (await import('axios')).default;
    let closing = false;
    const readHome = async (url: string, config?: AxiosRequestConfig): Promise<Readonly<{ status: number; data: unknown }>> => {
      if (closing) throw new Error('Memory startup HTTP fixture is closed');
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') {
        // Only the real child's retained-policy inventory is held. Bootstrap
        // also reads inventory independently; it must not satisfy this gate.
        if (held && boundary.runs > 0) {
          entered.resolve();
          if (config?.signal instanceof AbortSignal) await waitForObservation(release.promise, config.signal);
          else await release.promise;
        }
        return { status: 200, data: { sessions: path === '/v2/sessions' ? [createCompactSessionListRowFixture(retained)] : [], hasNext: false, nextCursor: null } };
      }
      if (path === '/v2/sessions/read-batch') return { status: 200, data: createSessionReadBatchResponseFixture({
        request: typeof config?.data === 'string' ? JSON.parse(config.data) : config?.data, sessions: [retained],
      }) };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'memory-startup-account' } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 0 } };
      if (path === '/v1/account/project-rows/list') return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [] } };
      throw new Error(`Unexpected Memory startup HTTP path: ${path}`);
    };
    vi.spyOn(axios, 'get').mockImplementation(readHome);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(FeaturesResponseSchema.parse({})));
    const socket = createApiSessionSocketStub({
      emit: (event, args, current) => {
        if (event === SOCKET_RPC_EVENTS.REGISTER) queueMicrotask(() => current.trigger(SOCKET_RPC_EVENTS.REGISTERED, args[0]));
      },
      emitWithAck: (event, payload) => event === 'machine-update-state'
        ? { result: 'success', version: 1, daemonState: (payload as { daemonState: string }).daemonState }
        : event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1
          ? { v: 1, result: 'success', revision: 1 } : { result: 'success', version: 1 },
    });
    bindApiSessionSocketMock(mockIo, socket);
    const credentials = { token: `opaque-startup-fixture-${ending}`, encryption: null };
    httpFixture.handlers.set(`Bearer ${credentials.token}`, readHome);
    const machine = { id: 'memory-startup-machine', encryptionMode: 'plain' as const,
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient(credentials.token, machine);
    const scheduler = createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) });
    const factory = createDaemonMachineBootstrapRuntime({
      api: await ApiClient.create(credentials), credentials, controlPort: 41233, runtimeId: 'memory-startup-runtime',
      publicReleaseChannel: 'dev', startupSource: 'manual', serviceLabel: undefined, transferRuntimeStatePublisher: null,
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      spawnSessionForInternalResume: async () => ({ type: 'success', sessionId: 'unused' }),
      stopSession: async () => ({ status: 'not_found' }), awaitAgentSessionOpen: undefined,
      isSessionAlreadyRunning: async () => false, loadLocalSessionMetadataForHandoff: async () => null,
      beforeShutdown: async () => {}, requestShutdown: () => {}, directPeerServerLifecycle: null,
      directTransferRegistryHost: createCliRegistryHostV1(), daemonServerWorkScheduler: scheduler,
      setDaemonServerWorkOnline: () => {}, onMachineConnectionOnline: async () => {},
      reconcileConnectedServicesProjection: async () => {}, isShuttingDown: () => closing,
    });
    let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
    const pending: Promise<unknown>[] = [];
    const starting = bootstrapMachineSyncRuntime({ ...factory, machineId: machine.id, machine,
      preferredHost: 'fixture.local', happyHomeDir: home, happyLibDir: home,
      filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false,
      createConnectedApiMachine: () => client, startAutomationWorkerForMachine: () => null,
      startVoiceInferenceWorkerForMachine: async () => null,
      connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
    }).then(value => { runtime = value; return value; });
    try {
      await entered.promise;
      expect(boundary.children).toHaveLength(1);
      expect(boundary.runs).toBe(1);
      await vi.waitFor(() => expect(client.isMachineControlRegistrationReady()).toBe(true));
      const running = await starting;
      const memory = running.memoryWorker;
      expect(memory).not.toBeNull();
      expect(memory!.getSettings().enabled).toBe(true);
      expect(memory!.getDeepDbPath()).toBeNull();
      expect(memory!.getWorkerStatus().state).not.toBe('idle');
      const manager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
      let statusReplied = false;
      const status = manager.invokeLocal(RPC_METHODS.DAEMON_MEMORY_STATUS, {})
        .then(value => { statusReplied = true; return value; });
      pending.push(Promise.allSettled([status]));
      const cancelled = new AbortController();
      const reason = new Error('cancelled Memory caller');
      const waiting = memory!.waitForReady(cancelled.signal);
      const rejected = expect(waiting).rejects.toBe(reason);
      cancelled.abort(reason);
      await rejected;
      let replied = false;
      const search = manager.invokeLocal(RPC_METHODS.DAEMON_MEMORY_SEARCH,
        { v: 1, query: 'retained', scope: { type: 'global' }, mode: 'deep', maxResults: 5 }).then(value => { replied = true; return value; });
      const purges = memory!.removeSessions(['retained-before-connect']);
      const reloading = memory!.reloadSettings();
      // Observe every request immediately, including when an assertion fails
      // before release; cleanup must not manufacture unhandled rejections.
      pending.push(Promise.allSettled([search, purges, reloading]));
      await new Promise<void>(resolve => { setImmediate(resolve); });
      expect(replied).toBe(false);
      expect(statusReplied).toBe(false);
      if (ending === 'stop') {
        await memory!.stop();
        await expect(search).rejects.toThrow();
        await expect(status).rejects.toThrow();
        await expect(purges).rejects.toThrow();
        await expect(memory!.waitForReady()).rejects.toThrow();
        expect(boundary.children.length).toBeGreaterThan(0);
        expect(boundary.children.every(child => child.closed)).toBe(true);
        expect(memory!.getDeepDbPath()).toBeNull();
        return;
      }
      held = false; release.resolve();
      await purges;
      await reloading;
      const searchResult = await search;
      expect(searchResult, JSON.stringify(searchResult)).toMatchObject({ v: 1, ok: true, hits: [] });
      await expect(status).resolves.toMatchObject({ enabled: true, activeIndexReady: true });
      expect(memory!.getDeepDbPath()).not.toBeNull();
      expect(memory!.listIndexedSessionIds()).not.toContain('retained-before-connect');
    } finally {
      closing = true;
      held = false; release.resolve();
      await starting;
      await Promise.all(pending);
      await runtime?.memoryWorker?.stop();
      runtime?.machineConnectionStateCleanup?.();
      runtime?.disposeInactiveSessionUsageLimitRecovery();
      await runtime?.stopPeerMediationLoopbackServer();
      await runtime?.stopMachineIrohAcceptor();
      await client.shutdown();
      Object.assign(configuration, { isDaemonProcess: priorDaemon });
    }
  });

  it('retains initial process failure for Memory callers until explicit reload recovers it', async () => {
    const { configuration } = await import('@/configuration');
    const priorDaemon = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: false });
    const processChannel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
    const boundary = createProcessBoundary();
    const spawn = vi.spyOn(processChannel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const { prepareMemoryWorker } = await import('./memoryWorker');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const paths = resolveMemoryIndexPaths();
    // A real filesystem failure inside the real child policy, not a rejected
    // spawn claiming uncertain custody has disappeared.
    await mkdir(paths.tier1DbPath, { recursive: true });
    await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, deleteOnDisable: false,
      embeddings: { ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'disabled' } });
    const worker = await prepareMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    try {
      await expect(worker.waitForReady()).rejects.toThrow();
      expect(worker.getWorkerStatus().state).toBe('error');
      expect(worker.getDeepDbPath()).toBeNull();
      const births = spawn.mock.calls.length;
      await expect(worker.embedQuery?.('must wait for admitted policy')).rejects.toThrow();
      await expect(worker.removeSessions(['retained'])).rejects.toThrow();
      expect(spawn).toHaveBeenCalledTimes(births);
      await rmdir(paths.tier1DbPath);
      await worker.reloadSettings();
      await worker.waitForReady();
      expect(worker.getSettings().enabled).toBe(true);
      expect(worker.getTier1DbPath()).not.toBeNull();
      expect(spawn).toHaveBeenCalledTimes(births + 1);
    } finally {
      try { await worker.stop(); }
      finally { Object.assign(configuration, { isDaemonProcess: priorDaemon }); }
    }
  });

  it('returns the prepared owner while its initial settings disk read waits, and gates only Memory readers', async () => {
    vi.useRealTimers();
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: false, deleteOnDisable: false });
    const { configuration } = await import('@/configuration');
    const settingsFile = configuration.settingsFile;
    const entered = deferred();
    const release = deferred();
    let held = false;
    vi.resetModules();
    // A single OS read is slow; all settings parsing, secrets admission and
    // worker policy remain real, and unrelated reads are not delayed.
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
        if (!held && args[0] === settingsFile) {
          held = true; entered.resolve(); await release.promise;
        }
        return await actual.readFile(...args);
      } };
    });
    const { prepareMemoryWorker } = await import('./memoryWorker');
    const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
    const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
    let prepared: Awaited<ReturnType<typeof prepareMemoryWorker>> | undefined;
    const starting = prepareMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' })
      .then(worker => { prepared = worker; return worker; });
    const pending: Promise<unknown>[] = [];
    try {
      await entered.promise;
      await vi.waitFor(() => expect(prepared).toBeDefined());
      const worker = prepared!;
      const manager = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain' });
      registerMachineMemoryRpcHandlers({ rpcHandlerManager: manager, memoryWorker: worker });
      let replies = 0;
      const requests = [RPC_METHODS.DAEMON_MEMORY_STATUS, RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET, RPC_METHODS.DAEMON_MEMORY_SEARCH]
        .map(method => manager.invokeLocal(method, method === RPC_METHODS.DAEMON_MEMORY_SEARCH
          ? { v: 1, query: 'held', scope: { type: 'global' }, mode: 'deep' } : {}).then(value => { replies++; return value; }));
      pending.push(Promise.allSettled(requests));
      await new Promise<void>(resolve => { setImmediate(resolve); });
      expect(replies).toBe(0);
      const abort = new AbortController();
      const reason = new Error('cancelled while reading Memory settings');
      const cancelled = expect(manager.invokeLocal(RPC_METHODS.DAEMON_MEMORY_STATUS, {}, { signal: abort.signal })).rejects.toBe(reason);
      abort.abort(reason);
      await cancelled;
      release.resolve();
      await expect(requests[0]).resolves.toMatchObject({ enabled: false, activeIndexReady: false });
      await expect(requests[1]).resolves.toMatchObject({ enabled: false });
      await expect(requests[2]).resolves.toMatchObject({ ok: false, errorCode: 'memory_disabled' });
    } finally {
      release.resolve();
      try { await (await starting).stop(); await Promise.all(pending); }
      finally { vi.doUnmock('node:fs/promises'); }
    }
  });

  it('stops a prepared Memory owner before it can create an initial child', async () => {
    const boundary = createProcessBoundary();
    const processChannel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
    vi.spyOn(processChannel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const { prepareMemoryWorker } = await import('./memoryWorker');
    await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, deleteOnDisable: false,
      embeddings: { ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'disabled' } });
    const worker = await prepareMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    await worker.stop();
    await expect(worker.waitForReady()).rejects.toThrow();
    expect(boundary.children).toHaveLength(0);
    expect(worker.getDeepDbPath()).toBeNull();
    await worker.stop();
  });

  it('retries the same authoritative removal after a real SQLite writer failure without reloading admitted policy', async () => {
    const { configuration } = await import('@/configuration');
    const priorDaemon = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: false });
    const boundary = createProcessBoundary();
    const processChannel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
    vi.spyOn(processChannel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
    const { writeMemorySettingsToDisk, DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { openProtectedSqliteDatabaseSync } = await import('../persistence/sqliteSync');
    const { startMemoryWorker } = await import('./memoryWorker');
    const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
    const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
    await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, indexMode: 'deep', deleteOnDisable: false,
      embeddings: { ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'disabled' } });
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    const paths = resolveMemoryIndexPaths();
    await mkdir(dirname(paths.tier1DbPath), { recursive: true });
    const seed = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
    seed.insertSummaryShard({ sessionId: 'revoked', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1,
      summary: 'retained removal marker', keywords: [], entities: [], decisions: [] });
    seed.close();
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const deep = openDeepIndexDb({ dbPath: paths.deepDbPath });
    deep.insertChunk({ sessionId: 'revoked', seqFrom: 1, seqTo: 1,
      createdAtFromMs: 1, createdAtToMs: 1, text: 'revoked searchable marker' });
    deep.close();
    const manager = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain' });
    registerMachineMemoryRpcHandlers({ rpcHandlerManager: manager, memoryWorker: worker });
    const search = () => manager.invokeLocal(RPC_METHODS.DAEMON_MEMORY_SEARCH,
      { v: 1, query: 'revoked', scope: { type: 'global' }, mode: 'deep' });
    await expect(search()).resolves.toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 'revoked' })] });
    const competingWriter = openProtectedSqliteDatabaseSync(paths.tier1DbPath);
    let locked = false;
    try {
      competingWriter.exec('BEGIN IMMEDIATE');
      locked = true;
      await expect(worker.removeSessions(['revoked'])).rejects.toThrow();
      competingWriter.exec('ROLLBACK');
      locked = false;
      const retained = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      try { expect(retained.listIndexedSessionIds()).toContain('revoked'); }
      finally { retained.close(); }
      for (const unrelated of [
        () => worker.applySessionArchivedState({ sessionId: 'unrelated', archived: false }),
        () => worker.removeSessions(['unrelated']),
        () => worker.reloadSettings(),
      ]) {
        await Promise.allSettled([unrelated()]);
        await expect(worker.waitForReady()).rejects.toThrow();
        await expect(search()).rejects.toThrow();
      }
      // This is the Account carrier replaying the unacknowledged same event,
      // not an explicit settings reload or an automatic indexer retry.
      await worker.removeSessions(['revoked']);
      const purged = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      try { expect(purged.listIndexedSessionIds()).not.toContain('revoked'); }
      finally { purged.close(); }
      await expect(search()).resolves.toMatchObject({ ok: true, hits: [] });
    } finally {
      if (locked) competingWriter.exec('ROLLBACK');
      competingWriter.close();
      try { await worker.stop(); }
      finally { Object.assign(configuration, { isDaemonProcess: priorDaemon }); }
    }
  });

  async function setup(hostOverrides: Partial<MemoryIndexerHost> = {}, settingsOverrides: Partial<MemorySettingsV1> = {}, pluginOptions: Readonly<{
    plugins?: readonly AdmittedBackgroundServicePlugin[];
    pluginHost?: BackgroundServiceProcessPluginHost;
  }> = {}) {
    const boundary = createProcessBoundary();
    const snapshots: MemoryIndexerPublication[] = [];
    let projected: MemoryIndexerSnapshot | undefined;
    const failures: unknown[] = [];
    const settlements: boolean[] = [];
    const host: MemoryIndexerHost = {
      publish: snapshot => {
        snapshots.push(snapshot);
        projected = applyMemoryIndexerPublication(projected ?? { ...snapshot, indexesQualified: false,
          candidateSessionIds: [], observedSeqBySessionId: [], editedSessionIds: [], externalSources: [] }, snapshot);
      },
      failed: error => { failures.push(error); },
      settled: () => { settlements.push(boundary.children.every(child => child.closed)); },
      readExternalSources: async () => ({ sources: [], configuredSourceKeys: [], changes: [] }),
      observeSessions: async ids => ids,
      runHint: async () => { throw new Error('Unexpected hint'); }, commitHint: async () => {},
      ...hostOverrides,
    };
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: false, deleteOnDisable: false, ...settingsOverrides };
    const { connectProcessMemoryIndexer: connectIndexer } = await import('./processMemoryIndexer');
    const params = { credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1', host,
      readSettings: () => settings, readIndexesQualified: () => projected?.indexesQualified === true
        && projected.settings.includeArchivedSessions === settings.includeArchivedSessions,
      spawnChannel: boundary.spawnChannel, ...pluginOptions };
    const connection = await connectIndexer(params);
    connections.push(connection);
    return { connection, boundary, snapshots, failures, settlements, settings, host, get projected() { return projected; } };
  }

  it.each(['idle', 'expire', 'retire', 'disable', 'crash'] as const)('owns one child grace with immediate busy results and no timer after %s', async ending => {
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const state = await setup({}, { enabled: true, indexMode: 'deep',
      embeddings: { ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'disabled' } });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const clockTimeout = globalThis.setTimeout;
    const clockClearTimeout = globalThis.clearTimeout;
    const graceTimers = new Set<ReturnType<typeof setTimeout>>();
    let graceFires = 0;
    let graceUntilMs: number | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 57_000) graceUntilMs = Date.now() + delay;
      const timer = clockTimeout(() => {
        if (delay === 57_000) { graceTimers.delete(timer); graceFires++; }
        callback();
      }, delay);
      if (delay === 57_000) graceTimers.add(timer);
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(timer => {
      if (timer !== undefined) graceTimers.delete(timer as ReturnType<typeof setTimeout>);
      clockClearTimeout(timer);
    });
    const { MemoryWorkerStatusV1Schema } = await import('@happier-dev/protocol/memory/memoryStatus');
    // The operation must resolve before any grace timer fires. Both process
    // peers, child engine, SQLite and the lifecycle are the production path.
    await state.connection.applySettings(state.settings);
    await vi.waitFor(() => expect(state.projected?.worker.currentPhase).toBe('idle_grace'));
    expect(graceTimers.size).toBe(1);
    for (let index = 0; index < (ending === 'idle' ? 0 : 10); index++) {
      await vi.advanceTimersByTimeAsync(30_000);
      const at = Date.now();
      await state.connection.embedQuery('fixture');
      expect(Date.now()).toBe(at);
      await vi.waitFor(() => expect(state.projected?.worker.currentPhase).toBe('idle_grace'));
      expect(MemoryWorkerStatusV1Schema.parse(state.projected?.worker)).toMatchObject({ idleGraceUntilMs: graceUntilMs });
      expect(state.boundary.children).toHaveLength(1);
      expect(state.boundary.children[0]?.closed).toBe(false);
      expect(graceFires).toBe(0);
      expect(graceTimers.size).toBe(1);
    }
    if (ending === 'expire' || ending === 'idle') {
      await vi.advanceTimersByTimeAsync(57_000);
      await vi.waitFor(() => expect(state.boundary.children[0]?.closed).toBe(true));
      expect(graceFires).toBe(1);
    } else if (ending === 'disable') {
      await state.connection.applySettings({ ...state.settings, enabled: false });
      await vi.waitFor(() => expect(state.boundary.children[0]?.closed).toBe(true));
    } else if (ending === 'crash') {
      state.boundary.children[0]?.crash();
      await vi.waitFor(() => expect(state.failures).not.toHaveLength(0));
    } else await state.connection.retire();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(state.boundary.children.filter(child => !child.closed)).toHaveLength(0);
    expect(state.boundary.children).toHaveLength(1);
    expect(graceFires).toBe(ending === 'expire' || ending === 'idle' ? 1 : 0);
    expect(graceTimers.size).toBe(0);
    // A dead child cannot publish; absent-child status is the real daemon
    // owner's contract, exercised separately below rather than this collector.
    if (ending !== 'retire' && ending !== 'crash') expect(state.projected?.worker).not.toMatchObject({ currentPhase: 'idle_grace' });
    if (ending === 'crash') {
      // Fifteen settled minutes above must not replay the failed run; only
      // this explicit demand is allowed to create the next child.
      await state.connection.embedQuery('explicit recovery');
      expect(state.boundary.children).toHaveLength(2);
      await state.connection.retire();
      expect(state.boundary.children.every(child => child.closed)).toBe(true);
      expect(graceTimers.size).toBe(0);
    }
  });

  it.each(['retire', 'crash'] as const)('clears child grace through the real daemon status owner on %s', async ending => {
    const boundary = createProcessBoundary();
    const processChannel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
    vi.spyOn(processChannel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, indexMode: 'deep', deleteOnDisable: false,
      embeddings: { ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'disabled' } });
    const { configuration } = await import('@/configuration');
    const priorDaemon = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: false });
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    try {
      await vi.waitFor(() => expect(worker.getWorkerStatus().currentPhase).toBe('idle_grace'));
      if (ending === 'retire') await worker.stop();
      else {
        boundary.children[0]!.crash();
        await vi.waitFor(() => expect(worker.getWorkerStatus().state).toBe('error'));
      }
      expect(worker.getWorkerStatus()).toMatchObject({ currentPhase: null, idleGraceUntilMs: null });
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: priorDaemon }); }
  });

  it('ignores out-of-scope deadlines and retries incomplete native discovery on explicit global refresh', async () => {
    const { createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    let sessionInventoryPages = 0;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions') {
        sessionInventoryPages++;
        return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
      }
      throw new Error(`Unexpected incomplete discovery HTTP path: ${path}`);
    });
    let inventoryPages = 0;
    let advertiseCandidate = false;
    const snapshots: MemoryIndexerPublication[] = [];
    const { createMemoryIndexer } = await import('./memoryIndexer');
    const { normalizeMemorySettings } = await import('@happier-dev/protocol/memory/memorySettings');
    // The vendor/plugin reader is the external boundary; the engine, traversal,
    // policy, persistence and explicit refresh path remain real.
    const engine = await createMemoryIndexer({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1',
      host: { publish: snapshot => { snapshots.push(snapshot); }, failed(error) { throw error; }, observeSessions: async ids => ids,
        runHint: async () => { throw new Error('Unexpected hint'); }, commitHint: async () => {},
        readExternalSources: async () => ({ configuredSourceKeys: [JSON.stringify(['fixture', 'root'])], changes: [],
          sources: [{ agentId: 'fixture', sourceKey: 'root', source: { kind: 'fixture' }, occurrenceId: 'fixture-occurrence' }] }) },
      resolveExternalReader: async () => ({
        async listCandidates() { inventoryPages++; return { ok: true, value: {
          candidates: advertiseCandidate ? [{ remoteSessionId: 'retry-source' }] : [], nextCursor: null, searchIncomplete: !advertiseCandidate } }; },
        async resolveLinkIdentity({ source, remoteSessionId }) { return { ok: true, value: { source, remoteSessionId, linkData: {} } }; },
        async pageTranscript() { return { ok: false, code: 'unavailable', retryable: true }; },
        async readAfterTranscript() { throw new Error('Unexpected tail'); },
      }),
    });
    const signal = new AbortController().signal;
    try {
      await engine.applySettings(normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep',
        conversationSearch: { indexExternal: { enabled: true, agents: ['fixture'] } } }), signal);
      // A null addressed admission can settle native work, but that work must
      // not turn the absence of Happier candidates into full Account demand.
      await engine.readExternalTranscriptPage({ source: { type: 'external_transcript',
        agentId: 'fixture', sourceKey: 'root', nativeSessionId: 'native-source' } }, signal);
      await engine.inventory(signal, [{ sessionId: 'removed-addressed-session', eligibility: null }]);
      await engine.runUntilSettled(signal);
      expect(sessionInventoryPages).toBe(0);
      expect(inventoryPages).toBe(1);
      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
      const { externalMemoryStorageId } = await import('./externalTranscriptIndex');
      const retained = openSummaryShardIndexDb({ dbPath: resolveMemoryIndexPaths().tier1DbPath });
      try {
        // Old persisted failures are not work in this inventory/policy scope.
        for (const sessionId of ['ineligible-retained-session', externalMemoryStorageId({ type: 'external_transcript',
          agentId: 'disabled-agent', sourceKey: 'old-root', nativeSessionId: 'old-native-session' })]) {
          retained.trySeedSessionCursorsIfMissing({ sessionId, nowMs: Date.now(), lastHintedSeq: 0, lastDeepIndexedSeq: 0 });
          retained.markDeepIndexFailure({ sessionId, nowMs: Date.now(), backoffBaseMs: 60_000, backoffMaxMs: 60_000 });
        }
      } finally { retained.close(); }
      await engine.tick(signal);
      await engine.runUntilSettled(signal);
      // The actual cold tick is a separate full reconciliation demand.
      expect(inventoryPages).toBe(2);
      expect(snapshots.filter(snapshot => snapshot.nextWorkAtMs !== undefined).at(-1)?.nextWorkAtMs).toBeNull();
      advertiseCandidate = true;
      await engine.ensureUpToDate(undefined, signal);
      await engine.runUntilSettled(signal);
      expect(inventoryPages).toBe(3);
      expect(snapshots.filter(snapshot => snapshot.nextWorkAtMs !== undefined).at(-1)?.nextWorkAtMs).toBeGreaterThan(Date.now());
    } finally { await engine.stop(); }
  });

  it('starts no idle child and exits after each successive SQLite purge settles', async () => {
    const { connection, boundary, settlements } = await setup();
    expect(boundary.children).toHaveLength(0);
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { tier1DbPath } = resolveMemoryIndexPaths();
    await mkdir(dirname(tier1DbPath), { recursive: true });
    const seed = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    seed.insertSummaryShard({ sessionId: 'removed', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
      summary: 'retained marker', keywords: [], entities: [], decisions: [], policyKey: 'fixture' });
    seed.close();
    await connection.removeSessions(['removed']);
    await expireChildGrace();
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
    const retained = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    try { expect(retained.listIndexedSessionIds()).not.toContain('removed'); }
    finally { retained.close(); }
    await connection.removeSessions(['absent']);
    await expireChildGrace();
    expect(boundary.children).toHaveLength(2);
    expect(boundary.children.every(child => child.closed)).toBe(true);
    expect(settlements).toEqual([true, true]);
    await connection.retire();
    expect(boundary.children[0]?.closed).toBe(true);
  });

  it.each([['deletion', false], ['deletion', true], ['revocation', false], ['revocation', true]] as const)(
    'exits after a retained Session purge and skips a repeated removal (%s, enabled=%s)', async (kind, enabled) => {
    const { ApiMachineClient } = await import('@/api/apiMachine');
    const { startMemoryWorker } = await import('./memoryWorker');
    const { subscribeMemorySessionRemoval } = await import('./subscribeMemorySessionRemoval');
    const processChannel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
    const { readAccountChangesCursor } = await import('@/persistence');
    const { accountSettingsParse } = await import('@happier-dev/protocol/account/settings/accountSettings');
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    const { SavedSecretResourceMaterialsResponseV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
    const { setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const { resolveAccountSettingsScopeKeyForToken } = await import('@/settings/accountSettings/accountSettingsScopeKey');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const { createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ sub: 'memory-removal-account' })}.`;
    const boundary = createProcessBoundary();
    // Substitute only the OS pipe/process. Both framed peers, the shared
    // lifecycle, Memory worker, indexer and SQLite purge remain real.
    vi.spyOn(processChannel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} })));
    let cursor = 0;
    let changesReads = 0;
    let eligibilityReads = 0;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'memory-removal-account' } };
      if (path === '/v1/auth/ping') return { status: 200, data: {} };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions/removed') {
        eligibilityReads++;
        return { status: 404, data: { error: 'Session not found' } };
      }
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200,
        data: { sessions: [], hasNext: false, nextCursor: null } };
      if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200,
        data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [] }) };
      if (path === '/v2/changes') {
        changesReads++;
        const after = Number(options?.params?.after ?? 0);
        const changed = cursor > after;
        return { status: 200, data: {
          changes: changed ? [{ cursor, kind: 'session', entityId: 'removed', changedAt: cursor,
            hint: kind === 'deletion' ? { v: 1, lifecycle: 'deleted' } : null }] : [],
          nextCursor: cursor,
          sessionAccessWitness: { v: 1, throughCursor: cursor, entries: changed
            ? [{ sessionId: 'removed', cursor, status: 'unavailable' }, { sessionId: 'kept', cursor, status: 'available' }] : [] },
        } };
      }
      throw new Error(`Unexpected Memory-removal HTTP path: ${path}`);
    });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) });
    await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled, deleteOnDisable: false });
    const worker = await startMemoryWorker({ credentials: { token, encryption: null }, machineId: 'machine-removal' });
    const purges = vi.spyOn(worker, 'removeSessions');
    const client = new ApiMachineClient(token, { id: 'machine-removal', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const socket = createApiSessionSocketStub({ emitWithAck: async () => ({ result: 'success', version: 1 }) });
    bindApiSessionSocketMock(mockIo, socket);
    client.onConnectedServicesProjection(async () => {});
    const dispose = subscribeMemorySessionRemoval({ memoryWorker: worker,
      onSessionChanged: listener => client.onSessionChanged(listener),
      onSessionTranscriptRevised: listener => client.onSessionTranscriptRevised(listener),
      onSessionDeletedChange: listener => client.onSessionDeletedChange(listener),
      onSessionAccessRevoked: listener => client.onSessionAccessRevoked(listener),
      onSessionAccessReset: listener => client.onSessionAccessReset(listener),
      onSessionArchivedStateChange: listener => client.onSessionArchivedStateChange(listener),
    });
    const retryOwner = (client as unknown as {
      connectedServicesProjectionRetry: { waitForIdle(): Promise<void> };
    }).connectedServicesProjectionRetry;
    const { tier1DbPath } = resolveMemoryIndexPaths();
    try {
      const initialBirths = boundary.children.length;
      await expireChildGrace();
      await vi.waitFor(() => expect(boundary.children.every(child => child.closed)).toBe(true));
      await mkdir(dirname(tier1DbPath), { recursive: true });
      const seed = openSummaryShardIndexDb({ dbPath: tier1DbPath });
      try {
        for (const sessionId of ['removed', 'kept']) seed.insertSummaryShard({ sessionId, seqFrom: 1, seqTo: 2,
          createdAtFromMs: 1, createdAtToMs: 2, summary: 'retained marker', keywords: [], entities: [], decisions: [], policyKey: 'fixture' });
      } finally { seed.close(); }
      client.connect();
      await vi.waitFor(() => expect(changesReads).toBe(1));
      await retryOwner.waitForIdle();
      expect(purges).not.toHaveBeenCalled();
      let firstPurgeRuns: number | undefined;
      for (cursor = 12; cursor <= 13; cursor++) {
        const previousReads = changesReads;
        socket.trigger('update', { id: `removal-${cursor}`, seq: cursor, createdAt: cursor, body: { t: 'account-change' } });
        await vi.waitFor(() => expect(changesReads).toBeGreaterThan(previousReads));
        await retryOwner.waitForIdle();
        await expireChildGrace();
        expect(await readAccountChangesCursor('memory-removal-account')).toBe(cursor);
        expect(purges.mock.calls).toEqual(Array.from({ length: cursor - 11 }, () => [['removed']]));
        expect(eligibilityReads).toBe(0);
        expect(boundary.children).toHaveLength(initialBirths + 1);
        expect(boundary.children.every(child => child.closed)).toBe(true);
        if (cursor === 12) firstPurgeRuns = boundary.runs;
        else expect(boundary.runs).toBe(firstPurgeRuns);
      }
      const retained = openSummaryShardIndexDb({ dbPath: tier1DbPath });
      try { expect(retained.listIndexedSessionIds()).toEqual(['kept']); }
      finally { retained.close(); }
    } finally {
      dispose();
      await client.shutdown();
      await worker.stop();
      clearActiveAccountSettingsSnapshot();
    }
  });

  it('removes and archives 1000 never-indexed Sessions through the daemon worker without connecting a child', async () => {
    const boundary = createProcessBoundary();
    const processChannel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
    vi.spyOn(processChannel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: false, deleteOnDisable: false });
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    try {
      for (let index = 0; index < 1000; index++) {
        await worker.removeSessions([`never-${index}`]);
        await worker.applySessionArchivedState({ sessionId: `never-${index}`, archived: true });
        await worker.applySessionArchivedState({ sessionId: `never-${index}`, archived: false });
        expect(boundary.children).toHaveLength(0);
      }
      expect(boundary.children).toHaveLength(0);
      expect(boundary.runs).toBe(0);
    } finally { await worker.stop(); }
  });

  it('consumes admitted exact Session observations across the process bridge without another inventory read', async () => {
    const { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
    const { resolveMemoryInventorySessionEligibility } = await import('./inventory/refreshMemoryInventory');
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const session = createSessionRecordFixture({ id: 'admitted-local', seq: 1, createdAt: Date.now(), updatedAt: Date.now(), encryptionMode: 'plain' });
    const eligibility = resolveMemoryInventorySessionEligibility({ session, backfillPolicy: 'all_history',
      includeArchivedSessions: false, enabledAtMs: 0, nowMs: Date.now() });
    expect(eligibility).not.toBeNull();
    const reads: string[] = [];
    let seq = 1;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
      if (path === `/v2/sessions/${session.id}`) return { status: 200, data: { session: { ...session, seq } } };
      if (path === `/v1/sessions/${session.id}/messages`) return { status: 200, data: {
        messages: Array.from({ length: seq }, (_, index) => ({ id: `admitted-row-${index + 1}`, seq: index + 1,
          createdAt: session.createdAt + index, updatedAt: session.createdAt + index, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: index ? 'secondadmittedmarker' : 'firstadmittedmarker' } } },
        })).filter(row => row.seq > Number(new URL(String(url)).searchParams.get('afterSeq'))),
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected admitted inventory HTTP path: ${path}`);
    });
    const state = await setup({}, { enabled: true, backfillPolicy: 'all_history', indexMode: 'deep', coveragePolicy: { type: 'full' },
      deep: { ...DEFAULT_MEMORY_SETTINGS.deep, minChunkMessages: 1 } });
    const { connection, projected: initial, boundary } = state;
    expect(initial).toBeUndefined();
    await connection.inventory(undefined, [{ sessionId: session.id, eligibility }]);
    expect(boundary.children).toHaveLength(1);
    expect(reads).not.toContain('/v2/sessions');
    const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const search = (query: string) => {
      const db = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
      try { return db.search({ query, scope: { type: 'global' }, maxResults: 10 }); }
      finally { db.close(); }
    };
    expect(search('firstadmittedmarker')).toHaveLength(1);
    seq = 2;
    await connection.inventory(undefined, [{ sessionId: session.id, eligibility: { ...eligibility!, observedSeq: seq } }]);
    expect(search('secondadmittedmarker')).toHaveLength(1);
    expect(reads.filter(path => path === `/v2/sessions/${session.id}`)).toHaveLength(1);
    await expireChildGrace();
    // The next child receives the exact removal too; it must not mistake the
    // empty addressed projection for a request to enumerate the Account.
    await connection.inventory(undefined, [{ sessionId: session.id, eligibility: null }]);
    await expireChildGrace();
    expect(boundary.children).toHaveLength(2);
    expect(reads.filter(path => path === '/v2/sessions' || path === '/v2/sessions/archived')).toEqual([]);
    expect(search('firstadmittedmarker')).toEqual([]);
    expect(search('secondadmittedmarker')).toEqual([]);
    expect(state.projected?.candidateSessionIds).not.toContain(session.id);
    expect(boundary.children.every(child => child.closed)).toBe(true);
  });

  it.each(['admission', 'refresh'] as const)('does not rewrite a revoked Session after a held exact %s observer resumes', async mode => {
    const { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const { resolveMemoryInventorySessionEligibility } = await import('./inventory/refreshMemoryInventory');
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const session = createSessionRecordFixture({ id: 'revoked-observer', seq: 1, createdAt: Date.now(), updatedAt: Date.now(),
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const entered = deferred();
    const release = deferred();
    let transcriptReads = 0;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === `/v2/sessions/${session.id}`) return { status: 200, data: { session } };
      if (path === `/v1/sessions/${session.id}/messages`) {
        transcriptReads++;
        return { status: 200, data: { messages: [{ id: 'revoked-row', seq: 1, createdAt: session.createdAt, updatedAt: session.updatedAt,
          messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'revokedobservermarker' } } } }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } };
      }
      throw new Error(`Unexpected revoked observer HTTP path: ${path}`);
    });
    const { connection } = await setup({ observeSessions: async ids => {
      entered.resolve();
      await release.promise;
      return ids;
    } }, { enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
      deep: { ...DEFAULT_MEMORY_SETTINGS.deep, minChunkMessages: 1 } });
    const eligibility = resolveMemoryInventorySessionEligibility({ session, backfillPolicy: 'all_history', includeArchivedSessions: false,
      enabledAtMs: 0, nowMs: Date.now() });
    const admitted = mode === 'admission' ? connection.inventory(undefined, [{ sessionId: session.id, eligibility }])
      : connection.refresh(session.id);
    const admission = Promise.allSettled([admitted]);
    await entered.promise;
    const revoked = Promise.allSettled([connection.inventory(undefined, [{ sessionId: session.id, eligibility: null }])]);
    // Both framed peers deliver synchronously; this boundary turn lets the
    // revocation command reach the held child before releasing its observer.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    release.resolve();
    expect(await admission).toMatchObject([{ status: 'fulfilled' }]);
    expect(await revoked).toMatchObject([{ status: 'fulfilled' }]);
    expect(transcriptReads).toBe(0);
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const retained = openSummaryShardIndexDb({ dbPath: resolveMemoryIndexPaths().tier1DbPath });
    try { expect(retained.listIndexedSessionIds()).not.toContain(session.id); }
    finally { retained.close(); }
  });

  it.each(['matching', 'reset', 'changed policy'] as const)('inherits retained daemon qualification only for a matching current policy (%s)', async mode => {
    const { createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const reads: string[] = [];
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
      throw new Error(`Unexpected qualification HTTP path: ${path}`);
    });
    const state = await setup({}, { enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
    const { createMemoryIndexer } = await import('./memoryIndexer');
    const params = { credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1', host: state.host,
      resolveExternalReader: async () => null };
    const initial = await createMemoryIndexer(params);
    try { await initial.applySettings(state.settings); }
    finally { await initial.stop(); }
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { tier1DbPath } = resolveMemoryIndexPaths();
    const retained = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    try { retained.trySeedSessionCursorsIfMissing({ sessionId: 'retained-access', nowMs: Date.now(), lastHintedSeq: 1, lastDeepIndexedSeq: 1 }); }
    finally { retained.close(); }
    reads.length = 0;
    const next = await createMemoryIndexer({ ...params, indexesQualified: mode !== 'reset' });
    try {
      await next.applySettings(mode === 'changed policy'
        ? { ...state.settings, coveragePolicy: { type: 'latest_messages', maxSemanticMessagesPerSession: 2 } }
        : state.settings);
      expect(reads.filter(path => path === '/v2/sessions' || path === '/v2/sessions/archived')).toHaveLength(mode === 'matching' ? 0 : 1);
      const check = openSummaryShardIndexDb({ dbPath: tier1DbPath });
      try { expect(check.listIndexedSessionIds().includes('retained-access')).toBe(mode === 'matching'); }
      finally { check.close(); }
    } finally { await next.stop(); }
  });

  it('serializes admitted inventory once across scale-shaped status changes', async () => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const sessions = Array.from({ length: 1024 }, (_, index) => createSessionRecordFixture({
      id: `publication-${index}`, seq: 0, createdAt: 1, updatedAt: 1, encryptionMode: 'plain',
      metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })),
    }));
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions') return { status: 200, data: { sessions, hasNext: false, nextCursor: null } };
      throw new Error(`Unexpected publication HTTP path: ${path}`);
    });
    const { createMemoryIndexer } = await import('./memoryIndexer');
    const { normalizeMemorySettings } = await import('@happier-dev/protocol/memory/memorySettings');
    const serialized: string[] = [];
    const engine = await createMemoryIndexer({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1',
      host: { publish: snapshot => { serialized.push(JSON.stringify(snapshot)); }, failed(error) { throw error; },
        observeSessions: async ids => ids, readExternalSources: async () => ({ sources: [], configuredSourceKeys: [], changes: [] }),
        runHint: async () => { throw new Error('Unexpected hint'); }, commitHint: async () => {} },
      resolveExternalReader: async () => null,
    });
    const signal = new AbortController().signal;
    try {
      await engine.applySettings(normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep',
        worker: { maxSessionsPerTick: 1 } }), signal);
      await engine.inventory(signal);
      for (let index = 0; index < 8; index++) await engine.tick(signal);
      const publications = serialized.map(value => JSON.parse(value));
      expect(new Set(publications.map(value => value.worker.currentPhase)).size).toBeGreaterThan(2);
      const inventories = publications.filter(value => value.candidateSessionIds?.length === sessions.length);
      expect(inventories).toHaveLength(1);
    } finally { await engine.stop(); }
  });

  it('does not withdraw qualified inventory while a same-policy child is reborn', async () => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'retained-publication', seq: 0, createdAt: 1, updatedAt: 1,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [session], hasNext: false, nextCursor: null } };
      throw new Error(`Unexpected rebirth HTTP path: ${path}`);
    });
    const state = await setup({}, { enabled: true });
    const { connection, boundary, snapshots } = state;
    await connection.inventory();
    expect(snapshots.some(snapshot => snapshot.indexesQualified === true)).toBe(true);
    expect(snapshots.some(snapshot => snapshot.candidateSessionIds?.includes(session.id))).toBe(true);
    const prior = state.projected!;
    await expireChildGrace();
    snapshots.length = 0;
    await connection.embedQuery('keyword fallback');
    await expireChildGrace();
    expect(boundary.children).toHaveLength(2);
    expect(snapshots.some(snapshot => snapshot.indexesQualified === false)).toBe(false);
    expect(snapshots.some(snapshot => snapshot.candidateSessionIds !== undefined)).toBe(false);
    expect(state.projected?.indexesQualified).toBe(true);
    expect(state.projected?.candidateSessionIds).toBe(prior.candidateSessionIds);
    expect(state.projected?.observedSeqBySessionId).toBe(prior.observedSeqBySessionId);
    await connection.removeSessions([session.id]);
    expect(state.projected?.candidateSessionIds).not.toContain(session.id);
    expect(state.projected?.observedSeqBySessionId.some(([id]) => id === session.id)).toBe(false);
  });

  it.each(['one', 'all', 'replacement'] as const)('cancels %s operations across the bridge without withdrawing a surviving demand', async mode => {
    const entered = deferred();
    let observationReads = 0;
    let operationAborted = false;
    const { connection, boundary, settings, failures } = await setup({ readExternalSources: async (_refresh, signal) => {
      observationReads += 1;
      if (observationReads === 2) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { operationAborted = true; reject(signal.reason); };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return { sources: [], configuredSourceKeys: [], changes: [] };
    } });
    const controller = new AbortController();
    const otherController = new AbortController();
    const cancelled = connection.applySettings(settings, controller.signal).then(() => null, error => error);
    await entered.promise;
    const purge = connection.removeSessions(['absent'], otherController.signal);
    const purged = Promise.allSettled([purge]);
    controller.abort();
    if (mode !== 'one') otherController.abort();
    const replacement = mode === 'replacement'
      ? Promise.allSettled([connection.removeSessions(['new-demand-after-cancellation'])]) : undefined;
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(await purged).toMatchObject([{ status: mode !== 'one' ? 'rejected' : 'fulfilled' }]);
    if (replacement) expect(await replacement).toMatchObject([{ status: 'fulfilled' }]);
    await expireChildGrace();
    expect(operationAborted).toBe(true);
    expect(boundary.children).toHaveLength(mode === 'replacement' ? 2 : 1);
    expect(boundary.children.every(child => child.closed)).toBe(true);
    expect(failures).toEqual([]);
  });

  it.each(['command', 'scheduler continuation', 'global scheduler continuation'] as const)('lets a purge abort held HTTP transcript work in the %s phase before acknowledging settlement', async phase => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'removed-in-flight', seq: phase === 'command' ? 1 : 2, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const entered = deferred();
    const firstPageRead = deferred();
    let transcriptAborted = false;
    let heldAfterSeq: number | undefined;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const request = new URL(String(url));
      const path = request.pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [session], hasNext: false, nextCursor: null } };
      if (path === `/v2/sessions/${session.id}`) return { status: 200, data: { session } };
      if (path === `/v1/sessions/${session.id}/messages`) {
        const afterSeq = Number(request.searchParams.get('afterSeq'));
        if (phase !== 'command' && afterSeq === 0) {
          firstPageRead.resolve();
          return { status: 200, data: {
          messages: [{ id: 'first-page', seq: 1, createdAt: 1000, updatedAt: 1000, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'removed retained first page marker' } } } }],
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
          } };
        }
        heldAfterSeq = afterSeq;
        const signal = config?.signal;
        entered.resolve();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => { transcriptAborted = true; reject(new Error('fixture transcript aborted')); };
          signal?.addEventListener?.('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      throw new Error(`Unexpected purge HTTP fixture path: ${path}`);
    });
    const { connection, boundary, settlements } = await setup({ readExternalSources: async () => {
      await new Promise<void>(resolve => { setImmediate(resolve); });
      return { sources: [], configuredSourceKeys: [], changes: [] };
    } }, {
      enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
    });
    const refreshing = connection.refresh(phase === 'global scheduler continuation' ? undefined : session.id);
    // Observe rejection immediately too: retirement must clean up a failing RED.
    const refreshed = Promise.allSettled([refreshing]);
    if (phase === 'global scheduler continuation') {
      await firstPageRead.promise;
      await vi.waitFor(() => { expect(heldAfterSeq).toBe(1); });
    }
    await entered.promise;
    expect(heldAfterSeq).toBe(phase === 'command' ? 0 : 1);
    if (phase !== 'command') {
      const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
      const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
      const retained = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
      try { expect(retained.search({ query: 'removed', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1); }
      finally { retained.close(); }
    }
    const purged = Promise.allSettled([connection.removeSessions([session.id])]);
    try {
      await vi.waitFor(() => { expect(transcriptAborted).toBe(true); });
      expect(await refreshed).toMatchObject([{ status: 'fulfilled' }]);
      expect(await purged).toMatchObject([{ status: 'fulfilled' }]);
      await expireChildGrace();
      expect(boundary.children).toHaveLength(1);
      expect(boundary.children[0]?.closed).toBe(true);
      expect(settlements).toEqual([true]);
      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
      const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
      const paths = resolveMemoryIndexPaths();
      const summary = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      const deep = openDeepIndexReader({ dbPath: paths.deepDbPath });
      try {
        expect(summary.listIndexedSessionIds()).not.toContain(session.id);
        expect(deep.search({ query: 'removed', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      } finally { summary.close(); deep.close(); }
    } finally {
      await connection.retire();
      await Promise.all([refreshed, purged]);
    }
  });

  it('joins writer and physical process disposal during idempotent retirement', async () => {
    const entered = deferred();
    let aborted = false;
    const { connection, boundary } = await setup({ readExternalSources: async (_refresh, signal) => {
      entered.resolve();
      await new Promise<void>(resolve => {
        const abort = () => { aborted = true; resolve(); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return { sources: [], configuredSourceKeys: [], changes: [] };
    } });
    const request = connection.removeSessions(['absent']).catch(error => error);
    await entered.promise;
    const terminal = boundary.holdClose();
    let retired = false;
    const first = connection.retire();
    const second = connection.retire();
    expect(second).toBe(first);
    const retiring = first.then(() => { retired = true; });
    await terminal.entered;
    expect(aborted).toBe(true);
    expect(retired).toBe(false);
    expect(boundary.children[0]?.closed).toBe(false);
    terminal.release();
    await retiring;
    expect(retired).toBe(true);
    expect(boundary.children[0]?.closed).toBe(true);
    await request;
    await expect(connection.removeSessions(['later'])).rejects.toThrow('memory_indexer_retired');
  });

  it('starts a fresh child without rereading an unchanged full Session snapshot', async () => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'unchanged-retained', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    let transcriptReads = 0;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(String(url));
      if (request.pathname === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (request.pathname === '/v2/sessions') return { status: 200, data: { sessions: [session], hasNext: false, nextCursor: null } };
      if (request.pathname === `/v2/sessions/${session.id}`) return { status: 200, data: { session } };
      if (request.pathname === `/v1/sessions/${session.id}/messages`) {
        transcriptReads += 1;
        return { status: 200, data: {
          messages: Number(request.searchParams.get('afterSeq')) === 0
            ? [{ id: 'retained-row', seq: 1, createdAt: 1000, updatedAt: 1000, messageRole: 'user',
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'unchanged retained snapshot marker' } } } }]
            : [],
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
        } };
      }
      throw new Error(`Unexpected retained inventory HTTP fixture path: ${request.pathname}`);
    });
    const observed = new Set<string>();
    const { connection, boundary } = await setup({
      observeSessions: async ids => {
        const fresh = ids.filter(id => !observed.has(id));
        for (const id of fresh) observed.add(id);
        return fresh;
      },
      // Match the asynchronous host observation boundary so a broken scheduler
      // remains cancellable by the ordinary test/lifecycle deadline.
      readExternalSources: async () => {
        await new Promise<void>(resolve => { setImmediate(resolve); });
        return { sources: [], configuredSourceKeys: [], changes: [] };
      },
    }, { enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
    await connection.inventory();
    const initialReads = transcriptReads;
    await expireChildGrace();
    expect(initialReads).toBeGreaterThan(0);
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
    const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const retained = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
    try { expect(retained.search({ query: 'unchanged', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1); }
    finally { retained.close(); }
    await connection.inventory();
    expect(transcriptReads).toBe(initialReads);
    await expireChildGrace();
    expect(boundary.children).toHaveLength(2);
    expect(boundary.children.every(child => child.closed)).toBe(true);
  });

  it('admits the current inventory on a deadline tick and exits after indexing', async () => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'deadline-source', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(String(url));
      if (request.pathname === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (request.pathname === '/v2/sessions') return { status: 200, data: { sessions: [session], hasNext: false, nextCursor: null } };
      if (request.pathname === `/v2/sessions/${session.id}`) return { status: 200, data: { session } };
      if (request.pathname === `/v1/sessions/${session.id}/messages`) return { status: 200, data: {
        messages: Number(request.searchParams.get('afterSeq')) === 0 ? [{ id: 'deadline-row', seq: 1,
          createdAt: 1000, updatedAt: 1000, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'deadline searchable marker' } } } }] : [],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected deadline HTTP fixture path: ${request.pathname}`);
    });
    const { connection, boundary } = await setup({}, { enabled: true, indexMode: 'deep',
      backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
    await connection.tick();
    await expireChildGrace();
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
    const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const retained = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
    try { expect(retained.search({ query: 'deadline', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1); }
    finally { retained.close(); }
  });

  it('has no resident child or births in fifteen settled minutes, then indexes an append in a fresh child', async () => {
    applyEnvValues({ HAPPIER_LOG_LEVEL: 'silent' });
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'demand-source', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    let seq = 1;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(String(url));
      if (request.pathname === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (request.pathname === '/v2/sessions') return { status: 200, data: { sessions: [{ ...session, seq }], hasNext: false, nextCursor: null } };
      if (request.pathname === `/v2/sessions/${session.id}`) return { status: 200, data: { session: { ...session, seq } } };
      if (request.pathname === `/v1/sessions/${session.id}/messages`) return { status: 200, data: {
        messages: Array.from({ length: seq }, (_, index) => ({ id: `demand-row-${index + 1}`, seq: index + 1,
          createdAt: 1000 + index, updatedAt: 1000 + index, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text',
            text: index === 2 ? 'resetcatchupmarker searchable' : index ? 'appendmarker searchable' : 'initialmarker searchable' } } },
        })).filter(row => row.seq > Number(request.searchParams.get('afterSeq'))),
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected worker demand HTTP fixture path: ${request.pathname}`);
    });
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, deleteOnDisable: false, indexMode: 'deep',
      backfillPolicy: 'all_history', coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { configuration } = await import('@/configuration');
    const priorDaemon = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const boundary = createProcessBoundary();
    const processChannel = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel');
    vi.spyOn(processChannel, 'spawnBackgroundServiceProcessChannel').mockImplementation(boundary.spawnChannel);
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    try {
      await vi.waitFor(() => expect(worker.getWorkerStatus().currentPhase).toBe('idle_grace'));
      await expireChildGrace();
      await vi.waitFor(() => {
        expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: session.id }, state: 'ready' });
        expect(boundary.children.length).toBeGreaterThan(0);
        expect(boundary.children.every(child => child.closed)).toBe(true);
      });
      const births = boundary.children.length;
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(boundary.children).toHaveLength(births);
      for (let index = 0; index < 1000; index++) {
        await worker.applySessionArchivedState({ sessionId: `idle-never-${index}`, archived: true });
        await worker.applySessionArchivedState({ sessionId: `idle-never-${index}`, archived: false });
      }
      expect(boundary.children).toHaveLength(births);
      seq = 2;
      await worker.noteSessionChanged?.({ sessionId: session.id });
      await vi.waitFor(() => expect(worker.getWorkerStatus().currentPhase).toBe('idle_grace'));
      await expireChildGrace();
      await vi.waitFor(() => {
        expect(boundary.children).toHaveLength(births + 1);
        expect(boundary.children.every(child => child.closed)).toBe(true);
        expect(worker.getWorkerStatus().state).toBe('idle');
      });
      const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
      await vi.waitFor(() => {
        const retained = openDeepIndexReader({ dbPath: worker.getDeepDbPath()! });
        try { expect(retained.search({ query: 'appendmarker', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1); }
        finally { retained.close(); }
        expect(boundary.children).toHaveLength(births + 1);
      });
      // A lost Account cursor carries no replayed Session identities. Its
      // existing access-reset entry must also reconcile the missed append.
      seq = 3;
      await worker.reconcileRetainedSessionAccess();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(worker.getWorkerStatus().currentPhase).toBe('idle_grace'));
      await expireChildGrace();
      await vi.waitFor(() => {
        expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: session.id }, state: 'ready' });
        expect(boundary.children.filter(child => !child.closed)).toHaveLength(0);
        const caughtUp = openDeepIndexReader({ dbPath: worker.getDeepDbPath()! });
        try { expect(caughtUp.search({ query: 'resetcatchupmarker', scope: { type: 'global' }, maxResults: 10 }))
          // Deep chunks may include earlier rows; the new marker and covered
          // high-water sequence establish catch-up without imposing chunk size.
          .toMatchObject([{ seqTo: 3 }]); }
        finally { caughtUp.close(); }
      });
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: priorDaemon }); vi.useRealTimers(); }
  });

  it('rejects an active demand on child death, reports failure, and starts fresh on later demand', async () => {
    const entered = deferred();
    let reads = 0;
    const { connection, boundary, failures, settlements } = await setup({ readExternalSources: async (_refresh, signal) => {
      if (++reads === 1) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return { sources: [], configuredSourceKeys: [], changes: [] };
    } });
    const request = connection.removeSessions(['absent']);
    const rejected = expect(request).rejects.toMatchObject({ code: 'background_service_process_exited' });
    await entered.promise;
    boundary.children[0]!.crash();
    await rejected;
    expect(failures).not.toHaveLength(0);
    expect(settlements).toEqual([]);
    await connection.removeSessions(['next']);
    expect(boundary.children).toHaveLength(2);
    expect(boundary.children[1]?.closed).toBe(true);
    expect(settlements).toEqual([true]);
  });

  it('returns query vectors over the strict bridge and never transports provider objects', async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push(String(url));
      expect(JSON.parse(String(init?.body))).toMatchObject({ input: 'selected query', model: 'fixture-model' });
      return new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.5, 0.75] }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const { connection, boundary } = await setup({}, { enabled: true, indexMode: 'deep', embeddings: {
      ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'custom', custom: { kind: 'openai_compatible',
        baseUrl: 'https://embeddings.example.test/v1', model: 'fixture-model',
        apiKey: { _isSecretValue: true, value: 'fixture-key' },
      },
    } });
    expect(await connection.embedQuery('selected query')).toEqual([0.25, 0.5, 0.75]);
    await expireChildGrace();
    expect(requests).toEqual(['https://embeddings.example.test/v1/embeddings']);
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
  });

  it('preserves native query ordinals and windows against the same in-process traversal', async () => {
    const { ingestCanonicalPluginManifest } = await import('@/plugins/manifest/ingest');
    const { bindPluginRuntimeSourceAuthority, resolvePluginSourceCustody } = await import('@/plugins/runtime/sourceAuthority');
    const { projectAdmittedBackgroundServicePlugin } = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource');
    const { createProductionPluginInvocationServiceOwners } = await import('@/plugins/runtime/invocation/services/production');
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const { resolveBackgroundServiceProcessBootstrap } = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBootstrap');
    const { createMemoryExternalTranscriptReader } = await import('./externalTranscriptSources');
    const { syncExternalMemoryTranscriptsBatch } = await import('./externalTranscriptIndex');
    const { getMemoryWindow } = await import('./getMemoryWindow');
    const { openDeepIndexDb, openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const pluginId = 'acme.memory-native-reader';
    const agentId = `${pluginId}/reader`;
    const occurrenceId = 'admitted-native-reader';
    const root = join(home, 'native-reader');
    const entryPath = join(root, 'daemon.mjs');
    const transcript = join(root, 'transcript.json');
    const inventoryMarker = join(root, 'unexpected-inventory');
    const activityAtMs = Date.now();
    await mkdir(root, { recursive: true });
    await writeFile(transcript, JSON.stringify({ items: [0, 1].map(ordinal => ({ id: `native-row-${ordinal}`, createdAtMs: activityAtMs + ordinal,
      messageRole: 'user', userProjection: 'source_fact', raw: { role: 'user', content: { type: 'text', text: `Native window marker ordinal${ordinal}` } },
    })), nextCursor: null }));
    await writeFile(entryPath, `
      import { readFile, writeFile } from 'node:fs/promises';
      export function activate(api) {
        api.agents.registerExternalSessions('reader', {
          async resolveSource(request) { return { ok: true, value: { source: request.source } }; },
          async resolveLinkIdentity(request) { return { ok: true, value: { source: request.source, remoteSessionId: request.remoteSessionId, linkData: {} } }; },
          async resolveLinkedIdentity(request) { return { ok: true, value: { source: request.source, remoteSessionId: request.remoteSessionId, linkData: request.linkData } }; },
          async listCandidates() { await writeFile(${JSON.stringify(inventoryMarker)}, 'started'); return { ok: true, value: { candidates: [{ remoteSessionId: 'native-1', updatedAtMs: ${activityAtMs} }], nextCursor: null } }; },
          async pageTranscript() { return { ok: true, value: JSON.parse(await readFile(${JSON.stringify(transcript)}, 'utf8')) }; },
          async readAfterTranscript() { return { ok: true, value: { outcome: 'already_current' } }; },
        });
      }
    `);
    const parsed = ingestCanonicalPluginManifest({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Memory native fixture',
      engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: { agents: [{ id: 'reader', title: 'Native fixture', capabilities: { surfaces: ['externalSessions'] },
        surfaces: { externalSession: { sources: [{ sourceKind: 'nativeFixture',
          schema: { fields: [{ name: 'kind', kind: 'literal', value: 'nativeFixture' }] },
          key: { segments: [{ kind: 'literal', value: 'nativeFixture' }] }, instances: [{ kind: 'default', constants: {} }],
        }] } },
      }] },
    }, { sourceProvenance: 'registryCustodied' });
    if (!parsed.ok) throw new Error(parsed.diagnostics.map(item => item.message).join('\n'));
    const sourceAuthority = bindPluginRuntimeSourceAuthority({ custody: { kind: 'development', registeredRootId: root }, resolvedRoot: root, observedRevision: 1 });
    const admitted = projectAdmittedBackgroundServicePlugin({
      target: { provenance: 'external', source: { kind: 'path' }, pluginId,
        manifestPath: join(root, 'plugin.json'), daemonEntryPath: entryPath,
        sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' }, manifest: parsed.manifest },
      occurrenceId, sourceCustody: resolvePluginSourceCustody(sourceAuthority), source: { kind: 'file_backed', sourceAuthority, entryPath },
    });
    const services = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
    const lifetime = new AbortController();
    const pluginHost: BackgroundServiceProcessPluginHost = { prepareAgentInvocationServices: request => services.prepareBackgroundServiceProcessOperationServices({
      plugin: { id: request.pluginId, version: request.pluginVersion }, contribution: { id: 'reader', qualifiedId: `${pluginId}/agents/reader` },
      occurrenceId: request.occurrenceId, correlationId: request.correlationId, surface: 'agent', signal: request.signal,
      isOccurrenceCurrent: () => !lifetime.signal.aborted,
    }, { hostAccessRequests: [], filesystemRoots: { pluginData: root, workspace: root, projects: new Map() } }) };
    const sourceSnapshot = {
      sources: [{ agentId, sourceKey: 'nativeFixture', source: { kind: 'nativeFixture' }, occurrenceId }],
      configuredSourceKeys: [JSON.stringify([agentId, 'nativeFixture'])], changes: [],
    };
    const request = { source: { type: 'external_transcript' as const, agentId, sourceKey: 'nativeFixture', nativeSessionId: 'native-1' } };
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
      throw new Error(`Unexpected native comparison HTTP path: ${path}`);
    });
    try {
      const state = await setup({ readExternalSources: async () => sourceSnapshot }, {
        enabled: true, indexMode: 'deep', deep: { ...DEFAULT_MEMORY_SETTINGS.deep, minChunkMessages: 1 },
        conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
        indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: [agentId] },
      } }, { plugins: [admitted], pluginHost });
      const { connection, boundary, settings, snapshots } = state;
      const page = await connection.readExternalPage(request);
      expect(boundary.readers).toContainEqual({ agentId, current: true, available: true });
      expect(page?.items.map(item => item.id)).toEqual(['native-row-0', 'native-row-1']);
      expect(existsSync(inventoryMarker)).toBe(false);
      expect(boundary.children).toHaveLength(1);
      await expireChildGrace();
      expect(boundary.children[0]?.closed).toBe(true);
      await connection.tick();
      await expireChildGrace();
      snapshots.length = 0;
      await connection.tick();
      const rebornSources = snapshots.flatMap(snapshot => snapshot.externalSources ?? []);
      expect(rebornSources.length).toBeGreaterThan(0);
      expect(rebornSources.every(source => source.state === 'ready')).toBe(true);
      const query = { query: 'Native', scope: { type: 'global' as const }, maxResults: 10, includeExternal: true };
      const processDb = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
      const normalize = (hits: ReturnType<typeof processDb.search>) => hits.map(({ source, sourceItemId, seqFrom, seqTo, text }) => ({ source, sourceItemId, seqFrom, seqTo, text }));
      let processHits: ReturnType<typeof normalize>;
      let processWindows: Awaited<ReturnType<typeof getMemoryWindow>>[];
      try {
        processHits = normalize(processDb.search(query));
        processWindows = await Promise.all(processHits.map(hit => getMemoryWindow({ source: request.source,
          sourceItemId: hit.sourceItemId!, paddingMessages: 1, signal: lifetime.signal, db: processDb,
          fetchExternalTranscriptPage: (request, signal) => connection.readExternalPage(request, signal) })));
      }
      finally { processDb.close(); }
      const baselineDb = openDeepIndexDb({ dbPath: join(home, 'in-process.sqlite') });
      const baselineWindows: Awaited<ReturnType<typeof getMemoryWindow>>[] = [];
      const baseline = await resolveBackgroundServiceProcessBootstrap({ entry: 'host', entryId: 'memory-indexer', payload: null, plugins: [admitted] }, {
        loadHostEntry: async () => ({ run: async context => {
          const sources = createMemoryExternalTranscriptReader({ onChange() {}, resolveReader: async id => context.agentRuntimesByAgentId?.get(id)?.externalSessions ?? null });
          try {
            await sources.refresh(sourceSnapshot, settings, context.signal);
            await sources.inventory(context.signal);
            await syncExternalMemoryTranscriptsBatch({ candidates: sources.take(1), db: baselineDb, settings,
              nowMs: activityAtMs, signal: context.signal, onSourceResult: sources.noteSyncResult });
            expect(await sources.readPage(request, settings, context.signal)).toEqual(page);
            for (const hit of processHits) baselineWindows.push(await getMemoryWindow({ source: request.source,
              sourceItemId: hit.sourceItemId!, paddingMessages: 1, signal: context.signal, db: baselineDb,
              fetchExternalTranscriptPage: request => sources.readPage(request, settings, context.signal) }));
          } finally { await sources.dispose(); }
        } }),
      });
      try {
        await baseline.run({ signal: lifetime.signal, services: { __backgroundServiceProcessPlugins: pluginHost } });
        expect(processHits).toHaveLength(2);
        expect([...processHits].sort((left, right) => left.seqFrom - right.seqFrom)).toEqual([0, 1].map(ordinal => ({
          source: request.source, sourceItemId: `native-row-${ordinal}`, seqFrom: ordinal + 1, seqTo: ordinal + 1,
          text: `Native window marker ordinal${ordinal}`,
        })));
        expect(processHits).toEqual(normalize(baselineDb.search(query)));
        const expectedWindow = [0, 1].map(ordinal => ({ sourceItemId: `native-row-${ordinal}`,
          text: `User: Native window marker ordinal${ordinal}` }));
        expect(processWindows.map(window => window.externalSnippets?.map(({ sourceItemId, text }) => ({ sourceItemId, text }))))
          .toEqual([expectedWindow, expectedWindow]);
        expect(processWindows).toEqual(baselineWindows);
      } finally { await baseline.dispose(); baselineDb.close(); }
      await connection.applySettings({ ...settings, conversationSearch: { ...settings.conversationSearch,
        indexExternal: { ...settings.conversationSearch.indexExternal, agents: [] } } });
      expect(state.projected?.externalSources).toEqual([]);
    } finally { lifetime.abort(); await services.dispose(); }
  });

  it('runs one hint turn when concurrent commands reach the same Session', async () => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const session = createSessionRecordFixture({ id: 'hint-session', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions/hint-session') return { status: 200, data: { session } };
      if (path === '/v1/sessions/hint-session/messages') return { status: 200, data: {
        messages: [{ id: 'hint-row', seq: 1, createdAt: 1000, updatedAt: 1000, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'concurrent hint marker' } } } }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected hint HTTP fixture path: ${path}`);
    });
    let hintRuns = 0;
    const { connection } = await setup({
      publish: () => {},
      runHint: async () => {
        hintRuns += 1;
        await new Promise(resolve => setTimeout(resolve, 50));
        return JSON.stringify({ shard: { v: 1, seqFrom: 0, seqTo: 0, createdAtFromMs: 0, createdAtToMs: 0,
          summary: 'Single summary', keywords: ['single'], entities: [], decisions: [] },
        synopsis: { v: 1, seqTo: 0, updatedAtMs: 0, synopsis: 'Single synopsis' } });
      },
      commitHint: async () => {},
    }, { enabled: true, indexMode: 'hints', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
      hints: { ...DEFAULT_MEMORY_SETTINGS.hints, enabled: true, updateMode: 'continuous',
        summarizerBackendId: 'fixture-agent', summarizerModelId: 'fixture-model', summarizerPermissionMode: 'read_only' },
    });
    await Promise.all([connection.refresh(session.id), connection.refresh(session.id), connection.refresh(session.id)]);
    expect(hintRuns).toBe(1);
  });

  it.each(['continuous', 'deadline admitted during settlement'] as const)('prepares hints in the child and delegates execution plus record commit to daemon-bound authorities (%s)', async mode => {
    if (mode !== 'continuous') {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(2000);
    }
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const session = createSessionRecordFixture({ id: 'hint-session', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions/hint-session') return { status: 200, data: { session } };
      if (path === '/v1/sessions/hint-session/messages') return { status: 200, data: {
        messages: [{ id: 'hint-row', seq: 1, createdAt: 1000, updatedAt: 1000, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'bridge hint transcript marker' } } } }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected hint HTTP fixture path: ${path}`);
    });
    const executions: MemoryHintRun[] = [];
    const commits: MemoryHintCommit[] = [];
    const { connection } = await setup({
      publish: snapshot => {
        // Cross the real hint idle deadline while this same child is still
        // serving its admitted run, before its scheduler settles.
        if (mode !== 'continuous' && snapshot.nextWorkAtMs != null && snapshot.nextWorkAtMs > Date.now()) {
          vi.setSystemTime(snapshot.nextWorkAtMs);
        }
      },
      runHint: async request => {
        executions.push(request);
        return JSON.stringify({ shard: { v: 1, seqFrom: 0, seqTo: 0, createdAtFromMs: 0, createdAtToMs: 0,
          summary: 'Bridge generated summary', keywords: ['bridge'], entities: [], decisions: [],
        }, synopsis: { v: 1, seqTo: 0, updatedAtMs: 0, synopsis: 'Bridge generated synopsis' } });
      },
      commitHint: async request => { commits.push(request); },
    }, { enabled: true, indexMode: 'hints', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
      hints: { ...DEFAULT_MEMORY_SETTINGS.hints, enabled: true, updateMode: mode === 'continuous' ? 'continuous' : 'onIdle', idleDelayMs: 5000,
        summarizerBackendId: 'fixture-agent', summarizerModelId: 'fixture-model', summarizerPermissionMode: 'read_only' },
    });
    await connection.refresh(session.id);
    expect(executions).toMatchObject([{ sessionId: session.id, backendId: 'fixture-agent', modelId: 'fixture-model', permissionMode: 'read_only' }]);
    expect(executions[0]?.prompt).toContain('bridge hint transcript marker');
    expect(commits).toMatchObject([{ sessionId: session.id,
      shardPayload: { summary: 'Bridge generated summary', seqFrom: 1, seqTo: 1 },
      synopsisPayload: { synopsis: 'Bridge generated synopsis', seqTo: 1 },
    }]);
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const reader = openSummaryShardIndexDb({ dbPath: resolveMemoryIndexPaths().tier1DbPath });
    try { expect(reader.listIndexedSessionIds()).toContain(session.id); }
    finally { reader.close(); }
  });
});
