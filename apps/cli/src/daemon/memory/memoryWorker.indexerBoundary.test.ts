import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import type { MemoryIndexerConnection, MemoryIndexerHost, MemoryIndexerSnapshot } from './memoryIndexerBoundary';
import type { SessionListPageV1 } from '@/session/transport/http/sessionsHttp';
import type { MemorySettingsV1 } from '@/settings/memorySettings';
import type { StoredCredentials } from '@/persistence';

// Transform the source host graph outside the operation's deadline.
await import('./memoryWorker');
await import('./memoryIndexer');
await import('@/plugins/testkit/admittedRuntime');

function deferred() {
  let resolved = false;
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = () => { resolved = true; done(); }; });
  return { promise, resolve, get resolved() { return resolved; } };
}

describe('Memory daemon/indexer boundary', () => {
  const env = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let home: string;
  let readInventory: (url: URL) => SessionListPageV1;
  const workers: { stop(): void | Promise<void> }[] = [];
  beforeEach(async () => {
    home = await createTempDir('memory-indexer-boundary-');
    applyEnvValues({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
    vi.useRealTimers();
    vi.resetModules();
    readInventory = () => ({ sessions: [], hasNext: false, nextCursor: null });
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: readInventory(new URL(String(url))) };
      throw new Error(`Unexpected boundary fixture HTTP path: ${path}`);
    });
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
    vi.useRealTimers();
    restoreEnvValues(env);
    vi.restoreAllMocks();
    vi.resetModules();
    await removeTempDir(home);
  });

  async function setup(overrides: Partial<MemoryIndexerConnection> = {}, beforeConnect?: () => Promise<void>, credentials: StoredCredentials = { token: 'fixture', encryption: null }) {
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    let saved = await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: false, deleteOnDisable: false });
    let host!: MemoryIndexerHost;
    const requests: string[] = [];
    // This is the child transport boundary, not a replacement for indexer logic.
    const connection: MemoryIndexerConnection = {
      applySettings: async settings => { saved = settings; publish(); },
      inventory: async () => {}, tick: async () => {}, refresh: async () => {}, revise: async () => {},
      removeSessions: async ids => { requests.push(`purge:${ids.join(',')}`); },
      reconcileAccess: async () => {}, archive: async () => {},
      readExternalPage: async () => null, embedQuery: async () => null,
      indexDocuments: async () => {}, retryEmbeddings: async () => {}, retire: async () => {},
      ...overrides,
    };
    const publish = (state: 'idle' | 'indexing' | 'error' = 'idle', indexesQualified = false, editedSessionIds: readonly string[] = [], extra: Partial<MemoryIndexerSnapshot> = {}) => host.publish({ settings: saved,
      embeddings: { mode: 'disabled', presetId: null, providerKind: null, modelId: null, runtimeState: 'unavailable', usingFallback: false, lastError: null },
      worker: { state, lastTickAtMs: null, lastInventoryAtMs: null, currentSessionId: null, currentPhase: null },
      indexesQualified, candidateSessionIds: ['pending'], observedSeqBySessionId: [], editedSessionIds, externalSources: [], ...extra });
    const connectIndexer = async (boundHost: MemoryIndexerHost) => {
      host = boundHost; requests.push('connect'); await beforeConnect?.(); publish(); return connection;
    };
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({ credentials, machineId: 'machine_1',
      deps: { fetchDecryptedTranscriptPageAfterSeq: async () => [], connectIndexer } });
    workers.push(worker);
    return { worker, requests, publish, readExternalSources: (signal: AbortSignal) => host.readExternalSources(false, signal),
      observeSessions: (ids: readonly string[]) => host.observeSessions(ids), enable: async (changes: Partial<MemorySettingsV1> = {}) => {
      await writeMemorySettingsToDisk({ ...saved, ...changes, enabled: true });
      await worker.reloadSettings();
    } };
  }

  async function seedSession(sessionId: string, kind: 'summary' | 'cursor' | 'queue' | 'chunk' | 'embedding' = 'cursor') {
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const paths = resolveMemoryIndexPaths();
    await mkdir(dirname(paths.tier1DbPath), { recursive: true });
    if (kind === 'chunk' || kind === 'embedding') {
      const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
      const db = openDeepIndexDb({ dbPath: paths.deepDbPath });
      try {
        if (kind === 'chunk') db.insertChunk({ sessionId, seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, text: 'retained marker' });
        else db.upsertEmbedding({ sessionId, seqFrom: 1, seqTo: 1, provider: 'fixture', modelId: 'fixture', embedding: new Float32Array([1]), updatedAtMs: 1 });
      } finally { db.close(); }
    } else {
      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const db = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      try {
        if (kind === 'summary') db.insertSummaryShard({ sessionId, seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1,
          summary: 'retained marker', keywords: [], entities: [], decisions: [] });
        else if (kind === 'queue') db.recordMemorySessionIndexState({ sessionId, status: 'queued', updatedAtMs: 1 });
        else db.trySeedSessionCursorsIfMissing({ sessionId, nowMs: 1, lastHintedSeq: 0, lastDeepIndexedSeq: 0 });
      } finally { db.close(); }
    }
  }

  it('retains completed tick and inventory timestamps when a fresh child reports only its own work', async () => {
    const { worker, publish } = await setup();
    await worker.embedQuery?.('initialize transport');
    publish('idle', true, [], { worker: { state: 'idle', lastTickAtMs: 100, lastInventoryAtMs: 90,
      currentSessionId: null, currentPhase: null } });
    // A query/purge child can finish without inventory or scheduler work.
    publish();
    expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', lastTickAtMs: 100, lastInventoryAtMs: 90 });
    // A later tick updates that fact without erasing the last inventory run.
    publish('idle', true, [], { worker: { state: 'idle', lastTickAtMs: 200, lastInventoryAtMs: null,
      currentSessionId: null, currentPhase: null } });
    expect(worker.getWorkerStatus()).toMatchObject({ lastTickAtMs: 200, lastInventoryAtMs: 90 });
  });

  it('drains finite native pages and admits zero further ticks without another source change', async () => {
    const { createMemoryIndexer } = await import('./memoryIndexer');
    const { normalizeMemorySettings } = await import('@happier-dev/protocol/memory/memorySettings');
    const signal = new AbortController().signal;
    let sourceReads = 0;
    let pageReads = 0;
    let tailReads = 0;
    const engine = await createMemoryIndexer({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1',
      host: { publish() {}, failed(error) { throw error; }, observeSessions: async ids => ids,
        runHint: async () => { throw new Error('Unexpected hint'); }, commitHint: async () => {},
        readExternalSources: async () => { sourceReads++; return { changes: [], configuredSourceKeys: ['["fixture","root"]'],
          sources: [{ agentId: 'fixture', sourceKey: 'root', source: { kind: 'fixture' }, occurrenceId: 'fixture' }] }; } },
      // Only the external native transcript transport is replaced. The engine,
      // inventory, scheduler, traversal, frontiers and SQLite are real.
      resolveExternalReader: async () => ({
        async listCandidates() { return { ok: true, value: { candidates: Array.from({ length: 3 }, (_, index) => ({ remoteSessionId: `native-${index}`, updatedAtMs: 0 })), nextCursor: null } }; },
        async resolveLinkIdentity({ source, remoteSessionId }) { return { ok: true, value: { source, remoteSessionId, linkData: {} } }; },
        async pageTranscript({ cursor }) {
          pageReads++;
          return { ok: true, value: { items: [], hasMore: !cursor, nextCursor: cursor ? null : 'second-page', tailCursor: 'tail' } };
        },
        async readAfterTranscript() { tailReads++; return { ok: true, value: { outcome: 'already_current' } }; },
      }),
    });
    try {
      await engine.applySettings(normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep',
        worker: { maxSessionsPerTick: 1 }, hints: { enabled: false },
        conversationSearch: { indexExternal: { enabled: true, agents: ['fixture'] } } }), signal);
      await engine.tick(signal);
      await engine.runUntilSettled(signal);
      expect(pageReads).toBe(6);
      const drained = { sourceReads, pageReads, tailReads };
      for (let request = 0; request < 5; request++) await engine.runUntilSettled(signal);
      expect({ sourceReads, pageReads, tailReads }).toEqual(drained);
    } finally { await engine.stop(); }
  });

  it('opens no owner metadata and reads no inventory pages over 15 settled minutes, admitting only changed local identities', async () => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { buildSessionMetadataEnvelopeFields } = await import('@/session/metadata/buildSessionMetadataEnvelopeCreateFields');
    const cipher = await import('@happier-dev/protocol/crypto/accountScopedCipher');
    const secret = new Uint8Array(32).fill(19);
    const credentials: StoredCredentials = { token: 'fixture', encryption: { type: 'legacy', secret } };
    const session = (id: string, machineId: string, seq = 1) => {
      const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'e2ee', storedContentMode: 'e2ee',
        encryptionKey: secret, encryptionVariant: 'legacy', metadata: { machineId, path: '/workspace' }, agentState: null });
      return createSessionRecordFixture({ id, seq, createdAt: Date.now(), updatedAt: Date.now(), encryptionMode: 'e2ee',
        share: null, metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata });
    };
    const sessions = new Map(Array.from({ length: 1_024 }, (_, index) => [`session-${index}`, session(`session-${index}`, 'machine_1')]));
    let pages = 0;
    const exactReads: string[] = [];
    const axios = (await import('axios')).default;
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }) };
      if (path === '/v2/sessions') { pages++; return { status: 200, data: { sessions: [...sessions.values()], hasNext: false, nextCursor: null } }; }
      const id = decodeURIComponent(path.slice('/v2/sessions/'.length));
      exactReads.push(id);
      return sessions.has(id) ? { status: 200, data: { session: sessions.get(id) } } : { status: 404, data: { error: 'Session not found' } };
    });
    const admitted: unknown[] = [];
    const { worker, enable, publish } = await setup({
      inventory: async (_signal, observations) => { admitted.push(observations); },
    }, undefined, credentials);
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const opens = vi.spyOn(cipher, 'openAccountScopedBlobCiphertext');
    try {
      await enable({ backfillPolicy: 'all_history' });
      await vi.advanceTimersByTimeAsync(0);
      pages = 0; opens.mockClear(); admitted.length = 0;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect({ pages, opens: opens.mock.calls.length }).toEqual({ pages: 0, opens: 0 });
      sessions.set('new-local', session('new-local', 'machine_1', 2));
      await worker.noteSessionChanged?.({ sessionId: 'new-local' });
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted).toEqual([[{ sessionId: 'new-local', eligibility: expect.objectContaining({ sessionId: 'new-local', observedSeq: 2 }) }]]);
      expect(exactReads).toEqual(['new-local']);
      expect(opens).toHaveBeenCalledTimes(1);
      publish('idle', true, [], { candidateSessionIds: ['new-local'], observedSeqBySessionId: [['new-local', 2]] });
      sessions.set('new-local', session('new-local', 'machine_1', 3));
      await worker.noteSessionChanged?.({ sessionId: 'new-local' });
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted.at(-1)).toEqual([{ sessionId: 'new-local', eligibility: expect.objectContaining({ sessionId: 'new-local', observedSeq: 3 }) }]);
      sessions.set('foreign', session('foreign', 'elsewhere'));
      const count = admitted.length;
      await worker.noteSessionChanged?.({ sessionId: 'foreign' });
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted).toHaveLength(count);
      sessions.set('new-local', session('new-local', 'elsewhere', 3));
      await worker.noteSessionChanged?.({ sessionId: 'new-local' });
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted.at(-1)).toEqual([{ sessionId: 'new-local', eligibility: null }]);
      expect(pages).toBe(0);
      expect(opens).toHaveBeenCalledTimes(4);
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous }); }
  });

  it('makes no child demands during settled minutes, unchanged settings, or unused Account settings changes', async () => {
    const demands: string[] = [];
    const { worker, enable } = await setup({
      applySettings: async () => { demands.push('settings'); },
      inventory: async () => { demands.push('inventory'); },
      tick: async () => { demands.push('tick'); },
      retryEmbeddings: async () => { demands.push('embeddings'); },
    });
    const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const { accountSettingsParse } = await import('@happier-dev/protocol');
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable();
      await vi.advanceTimersByTimeAsync(0);
      demands.length = 0;
      await worker.reloadSettings();
      await worker.reloadSettings();
      // Neither native sources nor embeddings consume Account preferences in
      // this policy. Availability and unrelated preference changes admit no work.
      setActiveAccountSettingsSnapshot({ source: 'cache', scopeKey: 'memory-idle-account',
        settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'memory-idle-account',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 2, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(demands).toEqual([]);
    } finally {
      await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous });
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('admits only consumed native source Account changes and never retries embeddings for them', async () => {
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { createAuthoredAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    const { createPluginManifestV2Fixture } = await import('@/plugins/testkit/manifestV2Fixture');
    const { resolvePluginContributes } = await import('@/plugins/projection/registry/resolvePluginContributions');
    const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const pluginId = 'acme.memory-account-source';
    const agentId = `${pluginId}/fixture`;
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      happyHomeDir: home,
      resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir })),
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId,
        runtime: { apiVersion: 1, agentFactories: [{ localAgentId: 'fixture', locator: {
          module: './factory', export: 'createFixtureAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'externalSessions',
        }, normalizedModulePath: 'factory.mjs', loadMode: 'immutable-js' }] },
        contributes: { agents: [{ id: 'fixture', title: 'Memory source', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { surfaces: ['externalSessions'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          surfaces: { externalSession: { sources: [{ sourceKind: 'configuredHome', schema: { fields: [
            { kind: 'literal', name: 'kind', value: 'configuredHome' }, { kind: 'string', name: 'homePath', nullish: true },
          ] }, key: { segments: [{ kind: 'field', field: 'homePath' }] }, instances: [{ kind: 'default', constants: {} }, { kind: 'agentSettingOverride',
            settingId: 'piAgentDir', byServerIdSettingId: 'piAgentDirByServerId', field: 'homePath', normalization: 'configuredPath' }] }] } },
        }] } }), files: { 'factory.mjs': `export function createFixtureAgentRuntime() { return { sessions: {} }; }
export const externalSessions = {
  async resolveSource({ source }) { return { ok: true, value: { source } }; },
  async listCandidates() { return { ok: true, value: { candidates: [], nextCursor: null } }; },
  async resolveLinkIdentity({ source, remoteSessionId }) { return { ok: true, value: { source, remoteSessionId, linkData: {} } }; },
  async resolveLinkedIdentity({ source, remoteSessionId, linkData }) { return { ok: true, value: { source, remoteSessionId, linkData } }; },
  async pageTranscript() { return { ok: true, value: { items: [], nextCursor: null } }; },
  async readAfterTranscript() { return { ok: true, value: { outcome: 'already_current' } }; },
};`,
          'daemon.mjs': `import { createFixtureAgentRuntime, externalSessions } from './factory.mjs';
export function activate(api) { api.agents.register('fixture', createFixtureAgentRuntime, {
  sessionRunnerFactory: { module: './factory', export: 'createFixtureAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'externalSessions' }
}); api.agents.registerExternalSessions('fixture', externalSessions); }` } }],
    });
    expect(runtime.registry.agentRuntimesByAgentId.get(agentId)?.externalSessions,
      JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId[pluginId])).toBeDefined();
    const demands: string[] = [];
    const { worker, enable } = await setup({
      tick: async () => { demands.push('tick'); },
      retryEmbeddings: async () => { demands.push('embeddings'); },
    });
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const { accountSettingsParse } = await import('@happier-dev/protocol');
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable({ conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
        indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: [agentId] } } });
      await vi.advanceTimersByTimeAsync(0);
      demands.length = 0;
      const account = { source: 'network' as const, scopeKey: 'memory-consumer-account',
        settings: accountSettingsParse({ piAgentDir: '/native/first', sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
        settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] };
      setActiveAccountSettingsSnapshot(account);
      await vi.advanceTimersByTimeAsync(0);
      demands.length = 0;
      setActiveAccountSettingsSnapshot({ ...account, settingsVersion: 2,
        settings: accountSettingsParse({ piAgentDir: '/native/first', sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(demands).toEqual([]);
      setActiveAccountSettingsSnapshot({ ...account, settingsVersion: 3,
        settings: accountSettingsParse({ piAgentDir: '/native/second' }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(demands).toEqual(['tick']);
      const accountSnapshots = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
      const current = accountSnapshots.getActiveAccountSettingsSnapshot()!;
      demands.length = 0;
      setActiveAccountSettingsSnapshot({ ...current, source: 'cache', settingsVersion: 4 });
      accountSnapshots.notifyActiveAccountConnectedServicesProjection(account.scopeKey);
      await vi.advanceTimersByTimeAsync(0);
      expect(demands).toEqual([]);
      const expectNativeDemand = async (update: () => void) => {
        demands.length = 0;
        update();
        await vi.advanceTimersByTimeAsync(0);
        expect(demands).toEqual(['tick']);
      };
      await expectNativeDemand(() => setActiveAccountSettingsSnapshot({ ...current, source: 'none', settingsVersion: 5 }));
      await expectNativeDemand(() => setActiveAccountSettingsSnapshot({ ...current, settingsVersion: 6 }));
      await expectNativeDemand(() => setActiveAccountSettingsSnapshot({ ...current, settingsVersion: 7,
        settingsSecretsReadKeys: [new Uint8Array([1])] }));
      await expectNativeDemand(accountSnapshots.clearActiveAccountSettingsSnapshot);
    } finally {
      await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous });
      resetActiveAccountSettingsSnapshotForTests();
      await runtime.dispose();
      await pluginReloadController.shutdown();
    }
  });

  it('admits no Account preference demand for locally configured embeddings', async () => {
    const demands: string[] = [];
    const { worker, enable } = await setup({ tick: async () => { demands.push('tick'); },
      retryEmbeddings: async () => { demands.push('embeddings'); } });
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const { accountSettingsParse } = await import('@happier-dev/protocol');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable({ embeddings: { ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'preset' } });
      await vi.advanceTimersByTimeAsync(0);
      demands.length = 0;
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'memory-embeddings-account',
        settings: accountSettingsParse({ piAgentDir: '/native/first' }), settingsVersion: 1,
        loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(demands).toEqual([]);
    } finally { await worker.stop(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('starts work once at the actual scheduler deadline and consumes a real wake after settling', async () => {
    let ticks = 0;
    let settled!: () => void;
    let consumeSources!: (signal: AbortSignal) => Promise<unknown>;
    const { worker, enable, publish, readExternalSources } = await setup({ tick: async signal => {
      ticks++;
      // A real child acknowledges its admitted source preparation before
      // publishing settlement. Keep this transport fixture faithful too.
      await consumeSources(signal ?? new AbortController().signal);
      settled();
    } });
    consumeSources = readExternalSources;
    settled = () => publish('idle', false, [], { nextWorkAtMs: null });
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable();
      await vi.advanceTimersByTimeAsync(0);
      ticks = 0;
      publish('idle', false, [], { nextWorkAtMs: Date.now() + 91_023 });
      await vi.advanceTimersByTimeAsync(91_022);
      expect(ticks).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(ticks).toBe(1);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(ticks).toBe(1);
      // Revisions are a real external fact, even with no periodic tick armed.
      await worker.noteSessionTranscriptRevised!({ sessionId: 'pending', seq: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous }); }
  });

  it('does not demand a follow-up child for a topology wake consumed by the current run', async () => {
    const entered = deferred();
    const release = deferred();
    let ticks = 0;
    let consume!: (signal: AbortSignal) => Promise<unknown>;
    const { worker, enable, readExternalSources } = await setup({ tick: async signal => {
      ticks++;
      if (ticks === 1) { entered.resolve(); await release.promise; }
      await consume(signal ?? new AbortController().signal);
    } });
    consume = readExternalSources;
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable();
      await entered.promise;
      const detach = worker.attachExternalObservation!({ registerAccountingSource: async () => {
        throw new Error('No native Agent is opted into this topology fixture');
      } });
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(ticks).toBe(1);
      detach();
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
      const { setActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
      const { accountSettingsParse } = await import('@happier-dev/protocol');
      setActiveAccountSettingsSnapshot({ source: 'cache', settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(ticks).toBe(2);
    } finally {
      release.resolve(); await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous });
      const { resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it.each([
    { backfillPolicy: 'new_only', includeArchivedSessions: false },
    { backfillPolicy: 'all_history', includeArchivedSessions: false },
    { backfillPolicy: 'all_history', includeArchivedSessions: true },
  ] as const)('observes eligible appends without demanding children for metadata or other machines ($backfillPolicy, archived: $includeArchivedSessions)', async ({ backfillPolicy, includeArchivedSessions }) => {
    const { createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'observed', seq: 4, createdAt: 500, updatedAt: 3000,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const foreign = { ...session, id: 'foreign', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_2' })) };
    // The eligible Session lives beyond the head page, including when it
    // predates enablement but has current activity under new_only.
    readInventory = url => url.searchParams.has('cursor')
      ? { sessions: [session], hasNext: false, nextCursor: null }
      : { sessions: [foreign], hasNext: true, nextCursor: 'older' };
    const axios = (await import('axios')).default;
    vi.mocked(axios.get).mockImplementation(async url => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (parsed.pathname === '/v2/sessions' || parsed.pathname === '/v2/sessions/archived') {
        return { status: 200, data: readInventory(parsed) };
      }
      const id = decodeURIComponent(parsed.pathname.slice('/v2/sessions/'.length));
      return { status: 200, data: { session: id === session.id ? session : foreign } };
    });
    let inventoryDemands = 0;
    let settle!: () => void;
    const { worker, enable, publish } = await setup({ inventory: async () => { inventoryDemands++; settle(); } });
    settle = () => publish('idle', false, [], { observedSeqBySessionId: [[session.id, session.seq]], nextWorkAtMs: null });
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable({ backfillPolicy, includeArchivedSessions, enabledAtMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      settle();
      inventoryDemands = 0;
      session.updatedAt++;
      foreign.seq++;
      await worker.noteSessionChanged!({ sessionId: session.id });
      await worker.noteSessionChanged!({ sessionId: foreign.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(inventoryDemands).toBe(0);
      session.seq++;
      await worker.noteSessionChanged!({ sessionId: session.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(inventoryDemands).toBe(1);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(inventoryDemands).toBe(1);
      // An archive fact can arrive after authorization but before the work
      // pump delivers that admitted observation to a child.
      session.seq++;
      await worker.noteSessionChanged!({ sessionId: session.id });
      session.archivedAt = Date.now();
      await worker.applySessionArchivedState({ sessionId: session.id, archived: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(inventoryDemands).toBe(includeArchivedSessions ? 2 : 1);
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous }); }
  });

  it('makes zero demands for settled idle archive updates with native indexing off', async () => {
    const archives: string[] = [];
    const { worker, requests, enable, publish } = await setup({ archive: async change => { archives.push(change.sessionId); } });
    await enable();
    publish('idle', true, [], { candidateSessionIds: [], observedSeqBySessionId: [] });
    const baseline = [...requests];
    for (let index = 0; index < 1000; index++) {
      await worker.applySessionArchivedState({ sessionId: `never-${index}`, archived: true });
      await worker.applySessionArchivedState({ sessionId: `never-${index}`, archived: false });
    }
    expect(archives).toEqual([]);
    expect(requests).toEqual(baseline);
    await seedSession('retained');
    await worker.applySessionArchivedState({ sessionId: 'retained', archived: false });
    expect(archives).toEqual([]);
    await worker.applySessionArchivedState({ sessionId: 'retained', archived: true });
    expect(archives).toEqual(['retained']);
    await enable({ includeArchivedSessions: true });
    await worker.applySessionArchivedState({ sessionId: 'retained', archived: true });
    expect(archives).toEqual(['retained']);
  });

  it('admits one current-inventory tick after an access reset loses Session change facts', async () => {
    let ticks = 0;
    let readSources!: (signal: AbortSignal) => ReturnType<MemoryIndexerHost['readExternalSources']>;
    const { worker, enable, readExternalSources } = await setup({
      tick: async signal => { ticks++; await readSources(signal!); },
    });
    readSources = readExternalSources;
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable();
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(1);
      await worker.reconcileRetainedSessionAccess();
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(ticks).toBe(2);
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous }); }
  });

  it('opens and prepares no SQLite readers for 1000 never-indexed transcript appends while retaining real revision work', async () => {
    await seedSession('retained');
    await seedSession('unrelated-deep', 'chunk');
    const revisions: string[] = [];
    const { worker, requests, enable } = await setup({ revise: async change => { revisions.push(change.sessionId); } });
    const sqlite = await import('@/daemon/persistence/sqliteSync');
    const openReader = sqlite.openProtectedSqliteDatabaseReaderSync;
    let prepares = 0;
    const readers = vi.spyOn(sqlite, 'openProtectedSqliteDatabaseReaderSync').mockImplementation(path => {
      const db = openReader(path);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, 'prepare').mockImplementation(sql => { prepares++; return prepare(sql); });
      return db;
    });
    for (let index = 0; index < 1000; index++) await worker.noteSessionTranscriptRevised!({ sessionId: `never-${index}`, seq: 1 });
    expect({ opens: readers.mock.calls.length, prepares }).toEqual({ opens: 0, prepares: 0 });
    expect(requests).toEqual([]);
    await worker.noteSessionTranscriptRevised!({ sessionId: 'retained', seq: 2 });
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable();
      await vi.advanceTimersByTimeAsync(0);
      expect(revisions).toEqual(['retained']);
      readers.mockClear(); prepares = 0;
      for (let index = 0; index < 1000; index++) await worker.noteSessionTranscriptRevised!({ sessionId: `never-${index}`, seq: 2 });
      expect({ opens: readers.mock.calls.length, prepares }).toEqual({ opens: 0, prepares: 0 });
      await worker.removeSessions(['retained']);
      await worker.noteSessionTranscriptRevised!({ sessionId: 'retained', seq: 3 });
      await vi.advanceTimersByTimeAsync(0);
      expect(revisions).toEqual(['retained']);
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous }); }
  });

  it('makes zero indexer demands for 1000 never-indexed Session removals, including beside unrelated work', async () => {
    const { worker, requests, enable, publish } = await setup();
    for (let index = 0; index < 1000; index++) await worker.removeSessions([`never-${index}`]);
    expect(requests).toEqual([]);
    await seedSession('unrelated');
    await enable();
    publish('indexing', true, [], { candidateSessionIds: [], observedSeqBySessionId: [],
      worker: { state: 'indexing', lastTickAtMs: null, lastInventoryAtMs: null, currentSessionId: 'unrelated', currentPhase: 'deep',
        activeOperations: [{ kind: 'transcript', sessionIds: ['unrelated'] }] } });
    const baseline = [...requests];
    for (let index = 0; index < 1000; index++) await worker.removeSessions([`never-${index}`]);
    expect(requests).toEqual(baseline);
  });

  it.each(['summary', 'cursor', 'queue', 'chunk', 'embedding'] as const)('starts an absent indexer only for retained %s state and joins one purge before acknowledging removal', async kind => {
    const purge = deferred();
    const entered = deferred();
    const selected: string[][] = [];
    const { worker, requests } = await setup({ removeSessions: async ids => { selected.push([...ids]); entered.resolve(); await purge.promise; } });
    await seedSession('removed', kind);
    expect(requests).toEqual([]);
    let acknowledged = false;
    const removal = worker.removeSessions(['never-indexed', ' removed ', 'removed']).then(() => { acknowledged = true; });
    try {
      await vi.waitFor(() => expect(requests).toContain('connect'));
      await entered.promise;
      expect(acknowledged).toBe(false);
    } finally { purge.resolve(); await removal; }
    expect(acknowledged).toBe(true);
    expect(requests).toEqual(['connect']);
    expect(selected).toEqual([['removed']]);
  });

  it('purges an exact in-flight writer once before it has published any retained state', async () => {
    const entered = deferred();
    const release = deferred();
    const purges: string[][] = [];
    const { worker, enable, publish } = await setup({ refresh: async () => { entered.resolve(); await release.promise; },
      removeSessions: async ids => { purges.push([...ids]); release.resolve(); } });
    await enable();
    publish('idle', true, [], { candidateSessionIds: [], observedSeqBySessionId: [] });
    const refreshing = worker.ensureUpToDate('writing');
    try {
      await entered.promise;
      await worker.removeSessions(['never-indexed', 'writing', 'writing']);
      expect(purges).toEqual([['writing']]);
    } finally { release.resolve(); await refreshing; }
  });

  it('purges only Sessions held by pending observations, admitted projections or published writers in one mixed batch', async () => {
    const { createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const purges: string[][] = [];
    const { worker, enable, publish, observeSessions } = await setup({ removeSessions: async ids => { purges.push([...ids]); } });
    await enable({ backfillPolicy: 'all_history' });
    publish('indexing', true, ['edited'], { candidateSessionIds: ['candidate'], observedSeqBySessionId: [['frontier', 0]],
      worker: { state: 'indexing', lastTickAtMs: null, lastInventoryAtMs: null, currentSessionId: 'current', currentPhase: 'deep',
        activeOperations: [{ kind: 'transcript', sessionIds: ['active'] }] } });
    await observeSessions(['observed']);
    const axios = (await import('axios')).default;
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      if (new URL(String(url)).pathname !== '/v2/sessions/pending') return get(url, options);
      return { status: 200, data: { session: createSessionRecordFixture({ id: 'pending', seq: 1,
        createdAt: Date.now(), updatedAt: Date.now(), encryptionMode: 'plain',
        metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) }) } };
    });
    await worker.noteSessionChanged!({ sessionId: 'pending' });
    const selected = ['candidate', 'frontier', 'edited', 'current', 'active', 'observed', 'pending'];
    await worker.removeSessions(['never-indexed', ...selected, 'active']);
    expect(purges).toEqual([selected]);
  });

  it('purges a pending Session observation once and never readmits its stale result after removal', async () => {
    const { createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const entered = deferred();
    const release = deferred();
    const purges: string[][] = [];
    const { worker, enable, publish } = await setup({ removeSessions: async ids => { purges.push([...ids]); } });
    await enable();
    publish('idle', true, [], { candidateSessionIds: [], observedSeqBySessionId: [] });
    const axios = (await import('axios')).default;
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      if (new URL(String(url)).pathname !== '/v2/sessions/observing') return get(url, options);
      entered.resolve();
      await release.promise;
      return { status: 200, data: { session: createSessionRecordFixture({ id: 'observing', seq: 1,
        createdAt: Date.now(), updatedAt: Date.now(), encryptionMode: 'plain',
        metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) }) } };
    });
    const observing = worker.noteSessionChanged!({ sessionId: 'observing' });
    try {
      await entered.promise;
      await worker.removeSessions(['observing', 'never-indexed']);
      expect(purges).toEqual([['observing']]);
      release.resolve();
      await observing;
      await worker.removeSessions(['observing']);
      expect(purges).toEqual([['observing']]);
    } finally { release.resolve(); await observing; }
  });

  it('waits for terminal writer acknowledgement before removing DB/WAL/SHM and restores saved settings', async () => {
    const terminal = deferred();
    const retiring = deferred();
    const { worker, enable } = await setup({ retire: async () => { retiring.resolve(); await terminal.promise; } });
    await enable();
    const dbPath = worker.getTier1DbPhysicalPath!();
    await writeFile(dbPath, 'writer-owned');
    const clearing = worker.clearIndex();
    try {
      await vi.waitFor(() => expect(retiring.resolved).toBe(true));
      expect(existsSync(dbPath)).toBe(true);
    } finally { terminal.resolve(); await clearing; }
    expect(existsSync(dbPath)).toBe(false);
    const { readMemorySettingsFromDisk } = await import('@/settings/memorySettings');
    expect((await readMemorySettingsFromDisk()).enabled).toBe(true);
  });

  it('retires a connection still starting before clear completes and never reuses that retired transport', async () => {
    const connecting = deferred();
    const release = deferred();
    let retired = 0;
    const { worker, requests } = await setup({ retire: async () => { retired += 1; } }, async () => {
      connecting.resolve(); await release.promise;
    });
    const first = worker.embedQuery!('before-disable').catch(error => error);
    await connecting.promise;
    const clearing = worker.clearIndex();
    // clearIndex enters its serialized retire before any filesystem removal.
    await new Promise<void>(resolve => setImmediate(resolve));
    release.resolve();
    await Promise.all([first, clearing]);
    expect(retired).toBe(1);
    await worker.embedQuery!('after-disable');
    expect(requests.filter(request => request === 'connect')).toHaveLength(2);
  });

  it('passes refresh cancellation through the child transport and returns its cancellation', async () => {
    const entered = deferred();
    const { worker, enable } = await setup({ refresh: async (_id, signal) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    } });
    await enable();
    const controller = new AbortController();
    const cancelled = new Error('refresh_cancelled');
    const refresh = worker.ensureUpToDate('selected', controller.signal);
    const outcome = refresh.then(() => null, error => error);
    try { await vi.waitFor(() => expect(entered.resolved).toBe(true)); }
    finally { controller.abort(cancelled); }
    expect(await outcome).toBe(cancelled);
  });

  it('retains a visible failure after a child crashes instead of projecting completed coverage', async () => {
    const crash = Object.assign(new Error('child exited unexpectedly'), { code: 'background_service_failed' });
    const { worker, requests, enable, publish } = await setup({ refresh: async () => { throw crash; } });
    await enable();
    expect(requests).toContain('connect');
    publish('indexing');
    await expect(worker.ensureUpToDate()).rejects.toBe(crash);
    expect(worker.getWorkerStatus().state).toBe('error');
    expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'pending' }, state: 'error' });
  });

  it('re-admits retained snapshot validation after an observed refresh is cancelled', async () => {
    const entered = deferred();
    const seen: (readonly string[])[] = [];
    let observe!: (ids: readonly string[]) => Promise<readonly string[]>;
    const { worker, enable, observeSessions } = await setup({ refresh: async (_id, signal) => {
      seen.push(await observe(['retained']));
      if (seen.length > 1) return;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    } });
    observe = observeSessions;
    await enable();
    const controller = new AbortController();
    const refresh = worker.ensureUpToDate('retained', controller.signal).catch(error => error);
    await entered.promise;
    controller.abort();
    await refresh;
    await worker.ensureUpToDate('retained');
    expect(seen).toEqual([['retained'], ['retained']]);
  });

  it('withdraws prior-policy search readers and reports failure if the replacement child cannot start', async () => {
    let starts = 0;
    const startupFailure = new Error('process_start_failed');
    const { worker, enable, publish } = await setup({}, async () => { if (++starts > 1) throw startupFailure; });
    await enable();
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    openSummaryShardIndexDb({ dbPath: worker.getTier1DbPhysicalPath!() }).close();
    publish('idle', true);
    expect(worker.getTier1DbPath()).toBe(worker.getTier1DbPhysicalPath!());
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const prior = worker.getSettings();
    await writeMemorySettingsToDisk({ ...prior,
      contentPolicy: { ...prior.contentPolicy, includeReasoning: !prior.contentPolicy.includeReasoning } });
    await expect(worker.reloadSettings()).rejects.toBe(startupFailure);
    expect(worker.getTier1DbPath()).toBeNull();
    expect(worker.getWorkerStatus().state).toBe('error');
  });

  it('keeps a deferred revision pending across a query-only child snapshot until its later completion', async () => {
    let deferred = true;
    let revisionRequests = 0;
    let send!: () => void;
    const { worker, enable, publish } = await setup({ revise: async () => { revisionRequests += 1; send(); } });
    send = () => publish('idle', true, deferred ? ['pending'] : []);
    await enable();
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const db = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPhysicalPath!() });
    try { db.recordMemorySessionIndexState({ sessionId: 'pending', status: 'indexed', updatedAtMs: 1 }); }
    finally { db.close(); }
    publish('idle', true);
    await worker.noteSessionTranscriptRevised!({ sessionId: 'pending', seq: 1 });
    expect(revisionRequests).toBe(0);
    await worker.ensureUpToDate('pending');
    // A query-only occurrence has no local dirty set; the daemon owns the
    // deferred fact until a source run positively completes it.
    publish('idle', true);
    expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'pending' }, state: 'indexing' });
    expect(revisionRequests).toBe(1);
    deferred = false;
    await worker.ensureUpToDate('pending');
    expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'pending' }, state: 'ready' });
  });
});
