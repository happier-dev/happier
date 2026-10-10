import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { Credentials, StoredCredentials } from '@/persistence';

describe('memoryWorker', () => {
  it('publishes Session readiness only after the latest observed cursor and revisions are indexed', async () => {
    let resume = () => {};
    let started = () => {};
    let deferred: Promise<void> | null = null;
    const session = { id: 'local', machineId: 'machine_1', seq: 1, createdAt: 1000, updatedAt: 2000,
      active: false, activeAt: 0, archivedAt: null, encryptionMode: 'plain' };
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: async () => ({ sessions: [session], nextCursor: null, hasNext: false }),
      fetchSessionById: async () => session,
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => {
        if (deferred) { started(); await deferred; }
        return { messages: [{ id: 'message', seq: 1, createdAt: 1000,
        messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'quartz' } } } }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
      },
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
      coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 't', encryption: null }, machineId: 'machine_1', deps: {
      fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }) => {
        if (deferred) { started(); await deferred; }
        return afterSeq < 1 ? [{ seq: 1, createdAtMs: 1000, role: 'user', content: { type: 'text', text: 'quartz' } }] : [];
      },
    } });
    try {
      await worker.ensureUpToDate('local');
      const source = { type: 'happier_session', sessionId: 'local' };
      expect(worker.getIndexSources?.()).toEqual([{ source, state: 'ready' }]);
      await worker.noteSessionTranscriptRevised?.({ sessionId: 'local', seq: 1 });
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'indexing' });
      await worker.ensureUpToDate('local');
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'ready' });
      deferred = new Promise(resolve => { resume = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      const syncing = worker.ensureUpToDate('local');
      await entered;
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'indexing' });
      await worker.noteSessionTranscriptRevised?.({ sessionId: 'local', seq: 1 });
      resume(); await syncing; deferred = null;
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'indexing' });
      await worker.ensureUpToDate('local');
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'ready' });
      await worker.clearIndex();
      expect(worker.getIndexSources?.().some(row => row.state === 'ready')).toBe(false);
    } finally { resume(); await worker.stop(); }
  });
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await createTempDir('happier-memory-worker-');
    applyEnvValues({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: 'https://api.example.test',
      HAPPIER_WEBAPP_URL: 'https://app.example.test',
    });
    vi.resetModules();
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'e2ee', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error(`Unexpected memory test HTTP path: ${String(url)}`);
    });
    // Transport-only empty history keeps the system-record parser/codec real.
    vi.doMock('@/session/transport/http/sessionSystemRecordsHttp', async () => {
      const actual = await vi.importActual<typeof import('@/session/transport/http/sessionSystemRecordsHttp')>(
        '@/session/transport/http/sessionSystemRecordsHttp',
      );
      return {
        ...actual,
        fetchSessionSystemRecordsPage: vi.fn(async () => ({ records: [], nextCursor: null, hasNext: false })),
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('@huggingface/transformers');
    restoreEnvValues(envBackup);
    vi.doUnmock('./hints/runMemoryHintsExecutionRun');
    vi.doUnmock('@/api/session/fetchEncryptedTranscriptWindow');
    vi.doUnmock('@/configuration');
    vi.doUnmock('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.doUnmock('@/session/transport/http/sessionSystemRecordsHttp');
    vi.doUnmock('@/session/transport/http/sessionsHttp');
    vi.doUnmock('@/ui/logger');
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
    if (homeDir) await removeTempDir(homeDir);
  });

  it('removes retained foreign and unknown Session ownership at restart and after a local Session moves', async () => {
    let localMachine = 'machine_1';
    let waitForVisibility: Promise<void> | undefined;
    let visibilityStarted = () => {};
    const sessions = () => [
      { id: 'local', machineId: localMachine },
      { id: 'foreign', machineId: 'machine_2' },
      { id: 'unknown' },
    ].map(session => ({ ...session, seq: 1, createdAt: 1000, updatedAt: 2000, active: false, activeAt: 0,
      archivedAt: null, encryptionMode: 'plain' }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async ({ archivedOnly }: { archivedOnly?: boolean }) => {
        if (waitForVisibility) { visibilityStarted(); await waitForVisibility; }
        return { sessions: archivedOnly ? [] : sessions(), nextCursor: null, hasNext: false };
      }),
      fetchSessionById: vi.fn(async ({ sessionId }: { sessionId: string }) => sessions().find(session => session.id === sessionId)),
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ messages: [{
        id: sessionId, seq: 1, createdAt: 1000, messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `quartz ${sessionId} conversation` } } },
      }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { startMemoryWorker } = await import('./memoryWorker');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const credentials: StoredCredentials = { token: 't', encryption: null };
    const first = await startMemoryWorker({ credentials, machineId: 'machine_1' });
    const path = first.getDeepDbPath()!;
    const seed = openDeepIndexDb({ dbPath: path });
    for (const session of sessions()) seed.insertChunk({ sessionId: session.id, seqFrom: 1, seqTo: 1,
      createdAtFromMs: 1000, createdAtToMs: 1000, text: `quartz ${session.id} conversation` });
    seed.close();
    expect([...first.listIndexedSessionIds()].sort()).toEqual(['foreign', 'local', 'unknown']);
    await first.stop();
    const worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });
    try {
      expect(worker.listIndexedSessionIds()).toEqual(['local']);
      await writeMemorySettingsToDisk({ ...worker.getSettings(), indexMode: 'hints' });
      await worker.reloadSettings();
      const closedDeep = openDeepIndexDb({ dbPath: path });
      for (const sessionId of ['foreign', 'unknown']) closedDeep.insertChunk({ sessionId, seqFrom: 1, seqTo: 1,
        createdAtFromMs: 1000, createdAtToMs: 1000, text: `quartz ${sessionId} conversation` });
      closedDeep.close();
      let resumeVisibility = () => {};
      waitForVisibility = new Promise<void>(resolve => { resumeVisibility = resolve; });
      const startedVisibility = new Promise<void>(resolve => { visibilityStarted = resolve; });
      await writeMemorySettingsToDisk({ ...worker.getSettings(), indexMode: 'deep' });
      const reopening = worker.reloadSettings();
      const state = await Promise.race([startedVisibility.then(() => 'pending'), reopening.then(() => 'reloaded')]);
      expect.soft(state).toBe('pending');
      expect.soft(worker.getDeepDbPath()).toBeNull();
      expect.soft(worker.getTier1DbPath()).toBeNull();
      resumeVisibility();
      await reopening;
      waitForVisibility = undefined;
      expect(worker.listIndexedSessionIds()).toEqual(['local']);
      localMachine = 'machine_2';
      await worker.ensureUpToDate();
      expect(worker.listIndexedSessionIds()).toEqual([]);
      const db = openDeepIndexDb({ dbPath: path });
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      db.close();
    } finally { await worker.stop(); }
  });

  it('indexes admitted documents with every stored topic and requalifies revisions and attachment access before mixed search', async () => {
    const axios = (await import('axios')).default;
    const { accountSettingsParse, MemorySearchResultV1Schema } = await import('@happier-dev/protocol');
    const { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
    const { emptyPromptLibraryRecordV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
    const { PromptLibraryCatalogKeyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
    const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
    const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
    const entry = (id: string) => ({ id, ref: { kind: 'doc' as const, artifactId: id }, enabled: true, placement: 'system_append' as const, maxChars: 1 });
    let attached = ['memory', 'instructions'];
    let revision = 1;
    let readable = true;
    let replaceAccountDuringSessionRead = false;
    const fact = (id: string, text: string, expiresAtMs?: number) => ({ id, text, createdAtMs: 1, sourceSessionRef: null, ...(expiresAtMs === undefined ? {} : { expiresAtMs }) });
    const artifact = (id: string) => ({ id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ v: 1, kind: id === 'memory' ? 'memory_doc.v1' : 'prompt_doc.v2', title: id }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(id === 'memory'
        ? { v: 1, index: [fact('index', revision === 1 ? 'quartz index' : 'updated index'), fact('expired-index', 'quartz expired index', 2)], topics: [
          { title: 'deployment', summary: 'Operations detail', facts: [fact('topic', 'quartz topic-only', 2)] },
          { title: 'archive', summary: 'History', facts: [fact('old', 'quartz archived')] },
        ] }
        : { v: 1, markdown: 'quartz instructions', createdAtMs: 1, updatedAtMs: 1 }) }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: revision, bodyVersion: revision, seq: 1, createdAt: 1, updatedAt: 1,
    });
    const accountSnapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
      scopeKey: resolveAccountSettingsScopeKey(credentials), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] };
    setActiveAccountSettingsSnapshot(accountSnapshot);
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v1/artifacts') return { status: 200, data: readable ? attached.map(artifact) : [] };
      if (path.startsWith('/v1/artifacts/')) return readable ? { status: 200, data: artifact(path.split('/').at(-1)!) } : { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected document indexing HTTP path: ${path}`);
    });
    // HTTP is the boundary; selection, metadata opening, content adapters and SQLite stay real.
    vi.doMock('@/session/transport/http/sessionsHttp', async () => ({
      ...(await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp')),
      fetchSessionById: async () => {
        if (replaceAccountDuringSessionRead) {
          replaceAccountDuringSessionRead = false;
          setActiveAccountSettingsSnapshot({ ...accountSnapshot, scopeKey: 'another-account' });
          setActiveAccountSettingsSnapshot(accountSnapshot);
        }
        return { id: 's1', seq: 1, createdAt: 1, updatedAt: 1, activeAt: 0, encryptionMode: 'plain',
          metadata: JSON.stringify(createTestMetadata({ work: { memoryEnabled: true, promptStack: attached.map(entry) } })) };
      },
      fetchSessionsPage: async () => ({ sessions: [{ id: 's1', machineId: 'machine_1', seq: 1, createdAt: 1, updatedAt: 1, activeAt: 0 }], nextCursor: null, hasNext: false }),
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => ({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history' });
    const { startMemoryWorker } = await import('./memoryWorker');
    const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
    const worker = await startMemoryWorker({ credentials, machineId: 'machine_1', deps: { fetchDecryptedTranscriptPageAfterSeq: async () => [] } });
    try {
      await worker.ensureUpToDate('s1');
      const dbPath = worker.getDeepDbPath()!;
      const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
      const db = openDeepIndexDb({ dbPath });
      db.insertChunk({ sessionId: 's1', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, text: 'quartz session' });
      expect(db.getDeepIndexStats()).toMatchObject({ deepDocumentEntryCount: 5, searchableDocumentCount: 2 });
      db.close();
      const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
      const manager = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
      registerMachineMemoryRpcHandlers({ rpcHandlerManager: manager, memoryWorker: worker });
      expect(await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`, params: null })).toMatchObject({ documentSearchSupported: true });
      const search = async (corpora: ('documents' | 'sessions')[] | null = ['documents', 'sessions'], global = false) => MemorySearchResultV1Schema.parse(await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SEARCH}`, params: {
        v: 1, query: 'quartz', scope: global ? { type: 'global' } : { type: 'session', sessionId: 's1' }, mode: 'deep', ...(corpora ? { corpora } : {}),
      } }));
      const result = await search();
      expect(result).toMatchObject({ ok: true, documents: { state: 'ready' } });
      if (!result.ok) throw new Error(result.error);
      expect(result.hits).toHaveLength(6);
      expect(result.hits).toContainEqual(expect.objectContaining({ type: 'artifact', factId: 'topic', location: { type: 'topic', title: 'deployment' }, summary: 'quartz topic-only' }));
      expect(result.hits).toContainEqual(expect.objectContaining({ type: 'artifact', factId: 'expired-index', location: 'archive', summary: 'quartz expired index' }));
      const documentsOnly = await search(['documents']);
      expect(documentsOnly.ok && documentsOnly.hits.every(hit => hit.type === 'artifact')).toBe(true);
      expect(documentsOnly.ok && documentsOnly.hits).toHaveLength(5);
      const sessionsOnly = await search(['sessions']);
      expect(sessionsOnly).toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's1' })] });
      expect(sessionsOnly).not.toHaveProperty('documents');
      expect(await search(null)).toEqual(sessionsOnly);
      const global = await search(['documents', 'sessions'], true);
      expect(global.ok && global.hits).toHaveLength(6);
      revision = 2;
      const revised = await search();
      expect(revised.ok && revised.hits.some(hit => hit.summary === 'quartz index')).toBe(false);
      replaceAccountDuringSessionRead = true;
      const retiredAccount = await search();
      expect(retiredAccount.ok && retiredAccount.hits.filter(hit => hit.type === 'artifact')).toEqual([]);
      expect(retiredAccount).toMatchObject({ documents: { state: 'pending' } });
      attached = [];
      const detached = await search();
      expect(detached.ok && detached.hits.filter(hit => hit.type === 'artifact')).toEqual([]);
      await search(['documents'], true);
      const pruned = openDeepIndexDb({ dbPath });
      expect(pruned.getDeepIndexStats()).toMatchObject({ deepDocumentEntryCount: 0, searchableDocumentCount: 0, deepChunkCount: 1 });
      pruned.close();
      attached = ['memory'];
      readable = false;
      const revoked = await search();
      expect(revoked.ok && revoked.hits.filter(hit => hit.type === 'artifact')).toEqual([]);
      expect(worker.getSettings().hints.enabled).toBe(false);
      expect(worker.getEmbeddingsDiagnostics()).toMatchObject({ runtimeState: 'unavailable' });
    } finally {
      await worker.stop();
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it.each([false, true])('exposes the worker while cold inference initializes (disable while pending: %s)', async (disableWhilePending) => {
    let finishInitialization = () => {};
    let initializationStarted = () => {};
    let initializationFinished = () => {};
    const transformerEnvironment = { cacheDir: '' };
    const pending = new Promise<void>((resolve) => { finishInitialization = resolve; });
    const started = new Promise<void>((resolve) => { initializationStarted = resolve; });
    const finished = new Promise<void>((resolve) => { initializationFinished = resolve; });
    // Transformers is the native/model-loading boundary; worker/provider lifecycle stays real.
    vi.doMock('@huggingface/transformers', () => ({
      env: transformerEnvironment,
      pipeline: async () => {
        initializationStarted();
        await pending;
        await mkdir(transformerEnvironment.cacheDir, { recursive: true });
        await writeFile(join(transformerEnvironment.cacheDir, 'model.bin'), 'downloaded fixture');
        initializationFinished();
        return async () => ({ data: new Float32Array([1, 0]), dims: [1, 2] });
      },
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', embeddings: { mode: 'preset', presetId: 'balanced' } });
    const { startMemoryWorker } = await import('./memoryWorker');
    const starting = startMemoryWorker({ credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } }, machineId: 'machine_1' });
    const worker = await Promise.race([
      starting,
      started.then(() => new Promise<null>((resolve) => setImmediate(() => resolve(null)))),
    ]);
    try {
      expect(worker, 'Daemon must be able to register memory RPC while inference is pending').not.toBeNull();
      expect(worker?.getEmbeddingsDiagnostics()).toMatchObject({ runtimeState: 'downloading' });
      if (disableWhilePending) {
        await writeMemorySettingsToDisk({ v: 1, enabled: false, indexMode: 'deep', deleteOnDisable: true });
        await worker?.reloadSettings();
      }
      finishInitialization();
      if (disableWhilePending) {
        await finished;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(worker?.getEmbeddingsDiagnostics()).toMatchObject({ runtimeState: 'unavailable', usingFallback: false });
        await vi.waitFor(async () => {
          await expect(stat(join(transformerEnvironment.cacheDir, 'model.bin'))).rejects.toBeTruthy();
        });
      } else {
        await vi.waitFor(() => expect(worker?.getEmbeddingsDiagnostics()).toMatchObject({ runtimeState: 'ready', usingFallback: false }));
      }
    } finally {
      finishInitialization();
      await (await starting).stop();
    }
  }, 60_000);

  it('creates the tier-1 sqlite DB when enabled', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });

    const { configuration } = await import('@/configuration');
    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.reloadSettings();
    const s = await stat(join(configuration.activeServerDir, 'memory', 'memory.sqlite'));
    expect(s.isFile()).toBe(true);

    await worker.stop();
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked memory root before creating an index', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });

    const { configuration } = await import('@/configuration');
    const outside = join(homeDir!, 'outside-memory');
    await mkdir(outside, { recursive: true });
    await mkdir(configuration.activeServerDir, { recursive: true });
    await symlink(outside, join(configuration.activeServerDir, 'memory'));

    const { startMemoryWorker } = await import('./memoryWorker');
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };

    await expect(startMemoryWorker({ credentials, machineId: 'machine_1' }))
      .rejects.toThrow('Protected local state must not be a symbolic link');
    await expect(stat(join(outside, 'memory.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads persisted settings when the worker starts so status matches the saved machine configuration', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });

    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    expect(worker.getSettings().enabled).toBe(true);
    expect(worker.getTier1DbPath()).toBeTruthy();

    await worker.stop();
  });

  it('creates the deep sqlite DB when enabled in deep mode', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep' });

    const { configuration } = await import('@/configuration');
    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.reloadSettings();
    const s = await stat(join(configuration.activeServerDir, 'memory', 'deep.sqlite'));
    expect(s.isFile()).toBe(true);

    await worker.stop();
  });


  it('resolves embeddings diagnostics on settings reload even before any session indexing runs', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      embeddings: {
        mode: 'custom',
        custom: {
          kind: 'openai_compatible',
          baseUrl: 'https://embeddings.example.test/v1',
          apiKey: { _isSecretValue: true, value: 'sk-test' },
          model: 'text-embedding-3-small',
        },
      },
    });

    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
      deps: {
        fetchDecryptedTranscriptPageAfterSeq: async () => [],
      },
    });

    await worker.reloadSettings();

    expect(worker.getEmbeddingsDiagnostics()).toMatchObject({
      mode: 'custom',
      providerKind: 'openai_compatible',
      modelId: 'text-embedding-3-small',
      runtimeState: 'ready',
      usingFallback: false,
    });

    await worker.stop();
  });

  it('reuses a failed embeddings resolution across background ticks but retries on settings publication, explicit use, and reload', async () => {
    vi.useFakeTimers();
    const argvBackup = process.argv.slice();
    let publishInventory = () => {};
    const inventoryReady = new Promise<void>((resolve) => { publishInventory = resolve; });
    const fetchSessionsPage = vi.fn(async () => {
      await inventoryReady;
      return {
        sessions: [{ id: 'sess-1', seq: 1, createdAt: 1_000, updatedAt: 2_000, activeAt: 0 }],
        nextCursor: null,
        hasNext: false,
      };
    });
    const pipeline = vi.fn(async () => {
      throw new Error('permanent local embeddings failure');
    });
    try {
      vi.doMock('@huggingface/transformers', () => ({ env: {}, pipeline }));
      vi.doMock('@/session/transport/http/sessionsHttp', () => ({
        fetchSessionsPage,
        fetchSessionById: async () => ({}),
      }));
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: { ...actual.configuration, isDaemonProcess: true },
        };
      });
      process.argv = ['node', 'happier', 'daemon', 'start-sync'];

      const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
      const {
        resetActiveAccountSettingsSnapshotForTests,
        setActiveAccountSettingsSnapshot,
      } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
      const { accountSettingsParse } = await import('@happier-dev/protocol');
      resetActiveAccountSettingsSnapshotForTests();
      await writeMemorySettingsToDisk({
        v: 1,
        enabled: true,
        indexMode: 'deep',
        backfillPolicy: 'new_only',
        worker: {
          tickIntervalMs: 500,
          inventoryRefreshIntervalMs: 5_000,
          maxSessionsPerTick: 1,
          sessionListPageLimit: 10,
        },
        embeddings: { mode: 'preset', presetId: 'balanced' },
      });

      const { startMemoryWorker } = await import('./memoryWorker');
      const worker = await startMemoryWorker({
        credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
        machineId: 'machine_1',
        deps: { fetchDecryptedTranscriptPageAfterSeq: async () => [] },
      });
      try {
        await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(fetchSessionsPage).toHaveBeenCalledTimes(1));
        publishInventory();
        await fetchSessionsPage.mock.results[0]!.value;
        await vi.advanceTimersByTimeAsync(2_500);
        expect(pipeline).toHaveBeenCalledTimes(1);

        setActiveAccountSettingsSnapshot({
          source: 'cache',
          settings: accountSettingsParse({}),
          settingsVersion: 1,
          loadedAtMs: Date.now(),
          settingsSecretsReadKeys: [],
        });
        await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(2));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pipeline).toHaveBeenCalledTimes(2);

        await worker.ensureUpToDate('sess-1');
        await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(3));
        await vi.advanceTimersByTimeAsync(1_500);
        expect(pipeline).toHaveBeenCalledTimes(3);

        await worker.reloadSettings();
        await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(4));
      } finally {
        publishInventory();
        await worker.stop();
        resetActiveAccountSettingsSnapshotForTests();
      }
    } finally {
      vi.doUnmock('@/configuration');
      vi.doUnmock('@/session/transport/http/sessionsHttp');
      process.argv = argvBackup;
      vi.useRealTimers();
    }
  });

  it('deletes DBs when disabled with deleteOnDisable=true', async () => {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });

    const { configuration } = await import('@/configuration');
    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.reloadSettings();
    const dummyCacheDir = join(configuration.activeServerDir, 'memory', 'models', 'transformers');
    await mkdir(dummyCacheDir, { recursive: true });
    await writeFile(join(dummyCacheDir, 'dummy.bin'), 'x', 'utf8');
    await writeMemorySettingsToDisk({ v: 1, enabled: false, indexMode: 'hints', deleteOnDisable: true });
    await worker.reloadSettings();

    await expect(stat(join(configuration.activeServerDir, 'memory', 'memory.sqlite'))).rejects.toBeTruthy();
    await expect(stat(join(dummyCacheDir, 'dummy.bin'))).rejects.toBeTruthy();
    expect(worker.getWorkerStatus()).toMatchObject({ state: 'disabled', currentSessionId: null, currentPhase: null });
    await worker.stop();
  });

  it('reports delete-on-disable filesystem failures to the settings caller', async () => {
    const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      rm: vi.fn(async (path: string, options?: Parameters<typeof actualFsPromises.rm>[1]) => {
        if (String(path).endsWith('/memory')) {
          throw new Error('memory_delete_failed');
        }
        return await actualFsPromises.rm(path, options);
      }),
    }));

    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'hints' });
    const { startMemoryWorker } = await import('./memoryWorker');
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });

    await writeMemorySettingsToDisk({
      v: 1,
      enabled: false,
      indexMode: 'hints',
      deleteOnDisable: true,
    });

    await expect(worker.reloadSettings()).rejects.toThrow('memory_delete_failed');
    await worker.stop();
  });

  it('does not hydrate unversioned committed summaries into a fresh local projection', async () => {
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false })),
      fetchSessionById: vi.fn(async () => ({
        id: 'sess-1', machineId: 'machine_1', seq: 12, createdAt: 1_000, updatedAt: 2_000,
        encryptionMode: 'plain',
        active: false, activeAt: 0, archivedAt: null,
      })),
    }));
    // The network adapter is the boundary; semantic extraction remains real.
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: vi.fn(async () => ({
        messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      })),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const memorySettings = await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      backfillPolicy: 'all_history',
    });
    const { resolveMemoryIndexPolicy } = await import('./transcript/coveragePolicy');
    const memoryPolicy = resolveMemoryIndexPolicy(memorySettings);
    vi.doMock('@/session/transport/http/sessionSystemRecordsHttp', async () => ({
      ...(await vi.importActual<typeof import('@/session/transport/http/sessionSystemRecordsHttp')>('@/session/transport/http/sessionSystemRecordsHttp')),
      fetchSessionSystemRecordsPage: async () => ({ records: [{ id: 'old-summary', sessionId: 'sess-1',
        namespace: 'memory', kind: 'summary_shard.v1', localId: 'memory:summary_shard:v1:10-12',
        content: { t: 'plain', v: { v: 1, seqFrom: 10, seqTo: 12, createdAtFromMs: 1000, createdAtToMs: 2000,
          summary: 'Obsolete OpenClaw conversation', keywords: [], entities: [], decisions: [], memoryPolicy } },
        createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }], nextCursor: null, hasNext: false }),
    }));

    const { startMemoryWorker } = await import('./memoryWorker');
    const { searchTier1Memory } = await import('./searchMemory');

    const credentials: StoredCredentials = { token: 't', encryption: null };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
      deps: {
        fetchDecryptedTranscriptPageAfterSeq: async () => [],
      },
    });

    await worker.reloadSettings();
    await worker.ensureUpToDate('sess-1');

    const dbPath = worker.getTier1DbPath();
    expect(dbPath).toBeTruthy();

    const result = searchTier1Memory({
      dbPath: dbPath!,
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(0);

    await worker.stop();
  }, 60_000);

  it('indexes transcript text into the deep index when ensureUpToDate is called', async () => {
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false })),
      fetchSessionById: vi.fn(async () => ({
        id: 'sess-1', machineId: 'machine_1', seq: 2, createdAt: 1_000, updatedAt: 2_000,
        active: false, activeAt: 0, archivedAt: null,
      })),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      backfillPolicy: 'all_history',
    });

    const { startMemoryWorker } = await import('./memoryWorker');
    const { searchTier2Memory } = await import('./searchMemory');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
      deps: {
        fetchDecryptedTranscriptPageAfterSeq: async () => [
          { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'hello openclaw' } },
          { seq: 2, createdAtMs: 2000, role: 'agent' as const, content: { type: 'text', text: 'we discussed memory search' } },
        ],
      },
    });

    await worker.reloadSettings();
    await worker.ensureUpToDate('sess-1');

    const tier1Path = worker.getTier1DbPath();
    expect(tier1Path).toBeTruthy();
    if (tier1Path) {
      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      const cursors = tier1.getSessionCursors({ sessionId: 'sess-1', nowMs: Date.now() });
      expect(cursors.lastDeepIndexedSeq).toBe(2);
      tier1.close();
    }

    const deepPath = worker.getDeepDbPath();
    expect(deepPath).toBeTruthy();

    const result = await searchTier2Memory({
      dbPath: deepPath!,
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep' },
      previewChars: 240,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.type === undefined ? result.hits[0]?.sessionId : null).toBe('sess-1');

    await worker.stop();
  });

  it('rebuilds an advanced empty projection when a content-policy change admits earlier rows', async () => {
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false })),
      fetchSessionById: vi.fn(async () => ({
        id: 'sess-policy', machineId: 'machine_1', seq: 1, createdAt: 1_000, updatedAt: 2_000,
        active: false, activeAt: 0, archivedAt: null,
        encryptionMode: 'plain',
      })),
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: vi.fn(async () => ({
        messages: [{ id: '1', seq: 1, createdAt: 1_000, messageRole: 'agent', content: {
          t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'newly admitted policy memory' } },
        } }],
        nextBeforeSeq: null, nextAfterSeq: null, hasMore: false,
      })),
    }));

    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      backfillPolicy: 'all_history',
      contentPolicy: { includeUserMessages: true, includeAssistantMessages: false },
    });

    const { startMemoryWorker } = await import('./memoryWorker');
    const { searchTier2Memory } = await import('./searchMemory');
    const credentials: StoredCredentials = { token: 't', encryption: null };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.ensureUpToDate('sess-policy');
    const deepPath = worker.getDeepDbPath()!;
    const beforePolicyChange = await searchTier2Memory({
      dbPath: deepPath,
      query: { v: 1, query: 'admitted', scope: { type: 'global' }, mode: 'deep' },
      previewChars: 240,
    });
    expect(beforePolicyChange.ok && beforePolicyChange.hits).toEqual([]);

    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      backfillPolicy: 'all_history',
      contentPolicy: { includeUserMessages: true, includeAssistantMessages: true },
    });
    await worker.reloadSettings();

    expect(worker.getSettings().contentPolicy.includeAssistantMessages).toBe(true);
    const rebuilt = await searchTier2Memory({
      dbPath: deepPath,
      query: { v: 1, query: 'admitted', scope: { type: 'global' }, mode: 'deep' },
      previewChars: 240,
    });
    expect(rebuilt.ok && rebuilt.hits.map((hit) => hit.type === undefined ? hit.sessionId : null)).toEqual(['sess-policy']);

    await worker.stop();
  });

  it('purges retained deep artifacts when deep policy changes while hints mode is active', async () => {
    const sessions = ['sess-stale-deep-policy', 'sess-deep-cursor-only'].map(id => ({
      id, machineId: 'machine_1', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 0, archivedAt: null,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => ({ sessions: archivedOnly ? [] : sessions, nextCursor: null, hasNext: false }),
      fetchSessionById: async ({ sessionId }: { sessionId: string }) => sessions.find(session => session.id === sessionId),
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => ({ messages: [], nextBeforeSeq: null, nextAfterSeq: null, hasMore: false }),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      deep: { includeToolOutput: true },
    });
    const { startMemoryWorker } = await import('./memoryWorker');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { searchTier2Memory } = await import('./searchMemory');
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });
    const deepPath = worker.getDeepDbPath()!;

    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      deep: { includeToolOutput: true },
    });
    await worker.reloadSettings();

    const seed = openDeepIndexDb({ dbPath: deepPath });
    seed.insertChunk({
      sessionId: 'sess-stale-deep-policy',
      seqFrom: 1,
      seqTo: 1,
      createdAtFromMs: 1,
      createdAtToMs: 1,
      text: 'stale private tool output',
      policyKey: 'old-deep-tool-output-policy',
    });
    seed.close();

    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      deep: { includeToolOutput: false },
    });
    await worker.reloadSettings();

    const result = await searchTier2Memory({
      dbPath: deepPath,
      query: { v: 1, query: 'private tool', scope: { type: 'global' }, mode: 'deep' },
      previewChars: 240,
    });
    expect(result.ok && result.hits).toEqual([]);
    expect(worker.getSettings().deep.includeToolOutput).toBe(false);

    const tier1Path = worker.getTier1DbPath()!;
    const tier1Seed = openSummaryShardIndexDb({ dbPath: tier1Path });
    tier1Seed.trySeedSessionCursorsIfMissing({
      sessionId: 'sess-deep-cursor-only',
      nowMs: 10,
      lastHintedSeq: 0,
      lastDeepIndexedSeq: 99,
    });
    tier1Seed.close();
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      deep: { includeToolOutput: true },
    });
    await worker.reloadSettings();
    const tier1Read = openSummaryShardIndexDb({ dbPath: tier1Path });
    expect(tier1Read.getSessionCursors({ sessionId: 'sess-deep-cursor-only', nowMs: 20 }).lastDeepIndexedSeq).toBe(0);
    tier1Read.close();
    await worker.stop();
  });

  it('uses the role-filtered transcript message API for default deep indexing', async () => {
    let transcriptText = 'role filtered deep memory row';
    let afterTranscriptRead: (() => Promise<void>) | undefined;
    const fetchSessionById = vi.fn(async () => ({
      id: 'sess-role-filter',
      machineId: 'machine_1',
      seq: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async ({ archivedOnly }: { archivedOnly?: boolean }) => ({ sessions: archivedOnly ? [] : [await fetchSessionById()], nextCursor: null, hasNext: false })),
      fetchSessionById,
    }));
    const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
    vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
      fetchEncryptedTranscriptPageAfterSeq,
    }));
    const fetchEncryptedTranscriptMessagesPage = vi.fn(async (args: { roles?: readonly string[]; afterSeq?: number }) => {
      const page = {
      messages: args.roles?.includes('agent') && (args.afterSeq ?? 0) < 1
        ? [
          {
            id: 'row-agent',
            seq: 1,
            createdAt: 1000,
            messageRole: 'agent',
            content: {
              t: 'plain',
              v: {
                role: 'agent',
                content: {
                  type: 'codex',
                  provider: 'codex',
                  data: { type: 'message', message: transcriptText },
                },
              },
            },
          },
        ]
        : [],
      hasMore: false,
      nextBeforeSeq: null,
      nextAfterSeq: null,
      };
      const afterRead = afterTranscriptRead;
      afterTranscriptRead = undefined;
      await afterRead?.();
      return page;
    });
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage,
    }));
    vi.doMock('@/session/transport/http/sessionSystemRecordsHttp', async () => {
      const actual = await vi.importActual<typeof import('@/session/transport/http/sessionSystemRecordsHttp')>(
        '@/session/transport/http/sessionSystemRecordsHttp',
      );
      return {
        ...actual,
        fetchSessionSystemRecordsPage: vi.fn(async () => ({
          records: [],
          nextCursor: null,
          hasNext: false,
        })),
      };
    });

    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      backfillPolicy: 'all_history',
      coveragePolicy: { type: 'full' },
    });

    const { startMemoryWorker } = await import('./memoryWorker');
    const { searchTier2Memory } = await import('./searchMemory');

    const credentials: StoredCredentials = { token: 't', encryption: null };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.reloadSettings();
    await worker.ensureUpToDate('sess-role-filter');

    const deepPath = worker.getDeepDbPath();
    expect(deepPath).toBeTruthy();
    const result = await searchTier2Memory({
      dbPath: deepPath!,
      query: { v: 1, query: 'filtered', scope: { type: 'global' }, mode: 'deep' },
      previewChars: 240,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits.some((hit) => hit.type === undefined && hit.sessionId === 'sess-role-filter')).toBe(true);
    transcriptText = 'revised sapphire conversation';
    await worker.noteSessionTranscriptRevised?.({ sessionId: 'sess-role-filter', seq: 1, messageId: 'row-agent' });
    await worker.ensureUpToDate('sess-role-filter');
    const edited = await searchTier2Memory({ dbPath: deepPath!,
      query: { v: 1, query: 'sapphire', scope: { type: 'global' }, mode: 'deep' }, previewChars: 240 });
    expect(edited.ok && edited.hits).toHaveLength(1);
    const obsolete = await searchTier2Memory({ dbPath: deepPath!,
      query: { v: 1, query: 'filtered', scope: { type: 'global' }, mode: 'deep' }, previewChars: 240 });
    expect(obsolete.ok && obsolete.hits).toHaveLength(0);
    transcriptText = 'intermediate amber conversation';
    await worker.noteSessionTranscriptRevised?.({ sessionId: 'sess-role-filter', seq: 1 });
    afterTranscriptRead = async () => {
      transcriptText = 'latest topaz conversation';
      await worker.noteSessionTranscriptRevised?.({ sessionId: 'sess-role-filter', seq: 1 });
    };
    await worker.ensureUpToDate('sess-role-filter');
    await worker.ensureUpToDate('sess-role-filter');
    const newest = await searchTier2Memory({ dbPath: deepPath!,
      query: { v: 1, query: 'topaz', scope: { type: 'global' }, mode: 'deep' }, previewChars: 240 });
    expect(newest.ok && newest.hits).toHaveLength(1);
    await writeMemorySettingsToDisk({ ...worker.getSettings(), indexMode: 'hints', hints: { ...worker.getSettings().hints, enabled: false } });
    await worker.reloadSettings();
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const tier1Path = worker.getTier1DbPath()!;
    const seedHint = (summary: string) => {
      const index = openSummaryShardIndexDb({ dbPath: tier1Path });
      index.insertSummaryShard({ sessionId: 'sess-role-filter', seqFrom: 1, seqTo: 1,
        createdAtFromMs: 1000, createdAtToMs: 1000, summary, keywords: [], entities: [], decisions: [] });
      index.markHintRunSuccess({ sessionId: 'sess-role-filter', seqTo: 1, nowMs: Date.now() });
      index.close();
    };
    seedHint('obsolete topaz summary');
    transcriptText = 'edited zirconium after disabled hints';
    await worker.noteSessionTranscriptRevised?.({ sessionId: 'sess-role-filter', seq: 1 });
    await worker.ensureUpToDate('sess-role-filter');
    const hintsAfterEdit = openSummaryShardIndexDb({ dbPath: tier1Path });
    expect.soft(hintsAfterEdit.search({ query: 'topaz', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
    hintsAfterEdit.close();
    const inactiveDeep = await searchTier2Memory({ dbPath: deepPath!,
      query: { v: 1, query: 'topaz', scope: { type: 'global' }, mode: 'deep' }, previewChars: 240 });
    expect.soft(inactiveDeep.ok && inactiveDeep.hits).toEqual([]);
    await writeMemorySettingsToDisk({ ...worker.getSettings(), indexMode: 'deep' });
    await worker.reloadSettings();
    await worker.ensureUpToDate('sess-role-filter');
    const afterModeSwitch = await searchTier2Memory({ dbPath: deepPath!,
      query: { v: 1, query: 'zirconium', scope: { type: 'global' }, mode: 'deep' }, previewChars: 240 });
    expect.soft(afterModeSwitch.ok && afterModeSwitch.hits).toHaveLength(1);
    seedHint('obsolete zirconium summary');
    transcriptText = 'edited diamond in deep mode';
    await worker.noteSessionTranscriptRevised?.({ sessionId: 'sess-role-filter', seq: 1 });
    await worker.ensureUpToDate('sess-role-filter');
    await writeMemorySettingsToDisk({ ...worker.getSettings(), indexMode: 'hints' });
    await worker.reloadSettings();
    const hintsAfterSwitch = openSummaryShardIndexDb({ dbPath: tier1Path });
    expect(hintsAfterSwitch.search({ query: 'zirconium', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
    hintsAfterSwitch.close();
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.objectContaining({
      roles: ['user', 'agent'],
      scope: 'main',
    }));
    expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();

    await worker.stop();
  });

  it('logs retryable selected-transcript fetch failures through the shared server endpoint classifier', async () => {
    const fetchSessionById = vi.fn(async () => ({
      id: 'sess-maintenance',
      machineId: 'machine_1',
      seq: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
      active: false,
      activeAt: 0,
      archivedAt: null,
    }));
    const fetchSessionsPage = vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false }));
    const maintenanceError = Object.assign(new Error('planned maintenance'), {
      response: { status: 503 },
    });
    const fetchEncryptedTranscriptMessagesPage = vi.fn(async () => {
      throw maintenanceError;
    });
    const loggerDebug = vi.fn();
    const runMemoryHintsExecutionRun = vi.fn(async () => {
      throw new Error('summarizer should not run when transcript rows are unavailable');
    });

    vi.doMock('@/ui/logger', () => ({
      logger: { debug: loggerDebug },
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionById,
      fetchSessionsPage,
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage,
    }));
    vi.doMock('./hints/runMemoryHintsExecutionRun', () => ({
      runMemoryHintsExecutionRun,
    }));

    const { resetServerEndpointFailureLogSamplingForTests } = await import('@/api/client/serverEndpointFailureLog');
    resetServerEndpointFailureLogSamplingForTests();
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      backfillPolicy: 'all_history',
      coveragePolicy: { type: 'full' },
      hints: {
        updateMode: 'continuous',
        idleDelayMs: 0,
        windowSizeMessages: 5,
        targetShardMessages: 10,
        maxShardChars: 12_000,
        maxSummaryChars: 500,
        maxKeywords: 5,
        maxEntities: 5,
        maxDecisions: 5,
        maxRunsPerHour: 999,
        maxShardsPerSession: 250,
        failureBackoffBaseMs: 0,
        failureBackoffMaxMs: 0,
      },
    });

    const { startMemoryWorker } = await import('./memoryWorker');

    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    const worker = await startMemoryWorker({
      credentials,
      machineId: 'machine_1',
    });

    await worker.reloadSettings();
    await expect(worker.ensureUpToDate('sess-maintenance')).rejects.toBe(maintenanceError);

    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalled();
    expect(runMemoryHintsExecutionRun).not.toHaveBeenCalled();
    expect(loggerDebug).toHaveBeenCalledWith(
      expect.stringContaining('memory worker selected transcript rows'),
      expect.objectContaining({
        classification: expect.objectContaining({
          retryable: true,
          statusCode: 503,
        }),
      }),
    );
    expect(loggerDebug.mock.calls.map((call) => call[0])).not.toContain(
      '[memoryWorker] Failed to fetch/decrypt transcript page (best-effort)',
    );

    await worker.stop();
  });

  it('continues background deep indexing for recently updated inactive sessions when backfill policy is new_only', async () => {
    vi.useFakeTimers();
    const argvBackup = process.argv.slice();
    try {
      process.argv = ['node', 'happier', 'daemon', 'start-sync'];
      vi.doMock('@/configuration', async () => {
        const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
        return {
          ...actual,
          configuration: {
            ...actual.configuration,
            isDaemonProcess: true,
          },
        };
      });
      let observedSeq = 1;
      const rows = [
        { seq: 1, createdAtMs: 1_000, role: 'user' as const, content: { type: 'text', text: 'initial deep memory row' } },
      ];
      let secondPageRequested = false;
      const fetchSessionsPage = vi.fn(async ({ activeOnly }: { activeOnly?: boolean }) => ({
        sessions: activeOnly
          ? []
          : [
            {
              id: 'sess-1',
              machineId: 'machine_1',
              seq: observedSeq,
              createdAt: 1_000,
              updatedAt: 9_000,
              activeAt: 0,
            },
          ],
        nextCursor: null,
        hasNext: false,
      }));
      const fetchSessionById = vi.fn(async () => ({ encryptionMode: 'plain' }));
      const fetchEncryptedTranscriptMessagesPage = vi.fn(async (args: { roles?: readonly string[]; afterSeq?: number; beforeSeq?: number }) => {
        const selected = args.roles
          ? rows.filter((row) => row.seq > (args.afterSeq ?? 0) && row.seq < (args.beforeSeq ?? Number.POSITIVE_INFINITY))
          : [];
        if (selected.some((row) => row.seq === 2)) secondPageRequested = true;
        return {
          messages: selected.map((row) => ({
            id: `row-${row.seq}`, seq: row.seq, createdAt: row.createdAtMs, messageRole: row.role,
            content: { t: 'plain', v: { role: row.role, content: row.content } },
          })),
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
        };
      });

      vi.doMock('@/session/transport/http/sessionsHttp', () => ({
        fetchSessionsPage,
        fetchSessionById,
      }));
      vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
        fetchEncryptedTranscriptMessagesPage,
      }));

      const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
      await writeMemorySettingsToDisk({
        v: 1,
        enabled: true,
        indexMode: 'deep',
        backfillPolicy: 'new_only',
        worker: {
          tickIntervalMs: 500,
          inventoryRefreshIntervalMs: 5_000,
          maxSessionsPerTick: 1,
          sessionListPageLimit: 10,
        },
      });

      const { startMemoryWorker } = await import('./memoryWorker');
      const credentials: StoredCredentials = { token: 't', encryption: null };
      const worker = await startMemoryWorker({
        credentials,
        machineId: 'machine_1',
      });

      await worker.reloadSettings();

      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const tier1Before = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPath()! });
      tier1Before.markDeepIndexSuccess({ sessionId: 'sess-1', seqTo: 1, nowMs: 5_000 });
      expect(tier1Before.getSessionCursors({ sessionId: 'sess-1', nowMs: 5_000 }).lastDeepIndexedSeq).toBe(1);
      tier1Before.close();

      rows.push({
        seq: 2,
        createdAtMs: Date.now(),
        role: 'user' as const,
        content: { type: 'text', text: 'inactive session follow-up should be indexed' },
      });
      observedSeq = 2;

      await vi.advanceTimersByTimeAsync(5_000);
      for (let attempt = 0; attempt < 20 && !secondPageRequested; attempt += 1) {
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(fetchSessionsPage).toHaveBeenCalled();
      expect(secondPageRequested).toBe(true);
      expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.objectContaining({ roles: ['user', 'agent'], scope: 'main' }));
      const tier1DbPath = worker.getTier1DbPath()!;
      const deepDbPath = worker.getDeepDbPath()!;
      const stopPromise = worker.stop();
      await vi.runAllTimersAsync();
      await stopPromise;

      const tier1After = openSummaryShardIndexDb({ dbPath: tier1DbPath });
      expect(tier1After.getSessionCursors({ sessionId: 'sess-1', nowMs: 15_000 }).lastDeepIndexedSeq).toBe(2);
      tier1After.close();
      const { searchTier2Memory } = await import('./searchMemory');
      const indexed = await searchTier2Memory({
        dbPath: deepDbPath,
        query: { v: 1, query: 'follow-up', scope: { type: 'global' }, mode: 'deep' },
        previewChars: 240,
      });
      expect(indexed.ok && indexed.hits.some((hit) => hit.type === undefined && hit.sessionId === 'sess-1')).toBe(true);

      expect(fetchSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ activeOnly: false }));
    } finally {
      process.argv = argvBackup;
      vi.useRealTimers();
    }
  });
});
