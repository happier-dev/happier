import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StoredCredentials } from '@/persistence';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { openSqliteDatabaseSync } from '../persistence/sqliteSync';

type RemovalEvent = 'deleted' | 'revoked' | 'reset';

const CREDENTIALS: StoredCredentials = {
  token: 't',
  encryption: null,
};

function createSource<T>() {
  const listeners = new Set<(change: T) => void | Promise<void>>();
  return {
    subscribe: (listener: (change: T) => void | Promise<void>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: async (change: T) => {
      for (const listener of listeners) await listener(change);
    },
  };
}

function countRows(dbPath: string, sql: string, ...bindings: unknown[]): number {
  const db = openSqliteDatabaseSync(dbPath);
  try {
    const row = db.prepare(sql).get(...(bindings as never[])) as { n?: unknown } | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

describe('memoryWorker retained removal while disabled', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let homeDir: string | undefined;
  const startedWorkers = new Set<Readonly<{ stop: () => void | Promise<void> }>>();

  beforeEach(async () => {
    homeDir = await createTempDir('happier-memory-disabled-removal-');
    applyEnvValues({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: 'https://api.example.test',
      HAPPIER_WEBAPP_URL: 'https://app.example.test',
    });
    vi.resetModules();
    // Currentness is the HTTP boundary; metadata opening and locality stay real.
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') {
        return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      throw new Error(`Unexpected retained-index HTTP path: ${String(url)}`);
    });
  });

  afterEach(async () => {
    let cleanupError: unknown;
    for (const worker of startedWorkers) {
      try {
        await worker.stop();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    startedWorkers.clear();
    vi.restoreAllMocks();
    restoreEnvValues(envBackup);
    vi.doUnmock('@/session/transport/http/sessionsHttp');
    vi.doUnmock('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.resetModules();
    if (homeDir) {
      try {
        await removeTempDir(homeDir);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    homeDir = undefined;
    if (cleanupError) throw cleanupError;
  });

  async function startSeededWorker() {
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      // Cursor-reset reconciliation now uses the canonical paged visible-
      // Session inventory rather than one request per retained id. Keep the
      // still-authorized Session in that source so this fixture exercises
      // selective revocation instead of declaring the whole Account empty.
      fetchSessionsPage: vi.fn(async ({ archivedOnly }: { archivedOnly?: boolean }) => ({
        sessions: archivedOnly
          ? []
          : [{ id: 'kept', seq: 2, createdAt: 1, updatedAt: 1, encryptionMode: 'plain',
            metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) }],
        nextCursor: null,
        hasNext: false,
      })),
      fetchSessionById: vi.fn(async ({ sessionId }: { sessionId: string }) => (
        sessionId === 'kept' ? { id: sessionId } : null
      )),
    }));
    // Both incremental and selected transcript reads reach this HTTP adapter.
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: vi.fn(async () => ({
        messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      })),
    }));

    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      backfillPolicy: 'all_history',
      deleteOnDisable: false,
    });

    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({
      credentials: CREDENTIALS,
      machineId: 'machine_1',
      deps: {
        fetchDecryptedTranscriptPageAfterSeq: async () => [],
      },
    });
    startedWorkers.add(worker);

    const tier1DbPath = worker.getTier1DbPath()!;
    const deepDbPath = worker.getDeepDbPath()!;
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const { memoryIndexPolicyKey, resolveMemoryIndexPolicy } = await import('./transcript/coveragePolicy');
    const policyKey = memoryIndexPolicyKey(resolveMemoryIndexPolicy(worker.getSettings()));
    const tier1 = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    const deep = openDeepIndexDb({ dbPath: deepDbPath });
    for (const sessionId of ['gone', 'kept']) {
      tier1.insertSummaryShard({
        sessionId,
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        summary: `retained memory marker for ${sessionId}`,
        keywords: ['retained', 'memory', 'marker'],
        entities: [],
        decisions: [],
        policyKey,
      });
      tier1.markHintRunSuccess({ sessionId, seqTo: 2, nowMs: 3 });
      tier1.recordMemorySessionIndexState({
        sessionId,
        status: 'indexed',
        selectedByBackfillPolicy: 'all_history',
        updatedAtMs: 3,
      });
      deep.insertChunk({
        sessionId,
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: `retained memory marker for ${sessionId}`,
        policyKey,
      });
      deep.upsertEmbedding({
        sessionId,
        seqFrom: 1,
        seqTo: 2,
        provider: 'local_transformers',
        modelId: 'model',
        embedding: new Float32Array([0.1, 0.2]),
        updatedAtMs: 3,
      });
    }
    tier1.close();
    deep.close();

    return { worker, tier1DbPath, deepDbPath, writeMemorySettingsToDisk };
  }

  it('clears every retained index and progress cursor through RPC while disabled, retaining settings', async () => {
    const { worker, tier1DbPath, deepDbPath, writeMemorySettingsToDisk } = await startSeededWorker();
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const external = openDeepIndexDb({ dbPath: deepDbPath });
    const source = { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'native-source', nativeSessionId: 'native-session' };
    external.insertChunk({ sessionId: 'external-native', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1,
      text: 'native external marker', source, sourceItemId: 'native-message' });
    external.setExternalSourceState({ sessionId: 'external-native', source, cursor: 'native-cursor', nextOrdinal: 2 });
    expect(external.listExternalSourceStates()).toHaveLength(1);
    external.close();
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const modelMarker = join(resolveMemoryIndexPaths().modelsDir, 'model-marker');
    await writeFile(modelMarker, 'retained model');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
    const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
    const manager = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
    registerMachineMemoryRpcHandlers({ rpcHandlerManager: manager, memoryWorker: worker });
    const conversationSearch = {
      standardSearch: { enabled: false },
      indexExternal: { enabled: true, agents: ['claude'], historyDays: 14, includeToolOutput: true },
    };
    const settings = { ...worker.getSettings(), enabled: false, conversationSearch };
    await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET}`, params: settings });
    const readback = await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`, params: {} });
    expect(readback).toMatchObject({ enabled: false, conversationSearch });
    await expect(manager.handleRequest({ method: 'machine_1:daemon.memory.clearIndex', params: { unexpected: true } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    const retainedExternal = openDeepIndexDb({ dbPath: deepDbPath });
    try { expect(retainedExternal.listExternalSourceStates()).toHaveLength(1); }
    finally { retainedExternal.close(); }
    await expect(manager.handleRequest({ method: 'machine_1:daemon.memory.clearIndex', params: {} })).resolves.toEqual({ ok: true });
    expect(worker.listIndexedSessionIds()).toEqual([]);
    expect(existsSync(tier1DbPath)).toBe(false);
    expect(existsSync(deepDbPath)).toBe(false);
    expect(await readFile(modelMarker, 'utf8')).toBe('retained model');
    await expect(manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`, params: {} })).resolves.toEqual(readback);
    // Repeated clear is idempotent; re-enabling still creates working indexes.
    await manager.handleRequest({ method: 'machine_1:daemon.memory.clearIndex', params: {} });
    await writeMemorySettingsToDisk({ ...settings, enabled: true });
    await worker.reloadSettings();
    expect(worker.getDeepDbPath()).toBe(deepDbPath);
    expect(countRows(tier1DbPath, 'SELECT COUNT(*) AS n FROM session_cursors;')).toBe(0);
    expect(countRows(tier1DbPath, 'SELECT COUNT(*) AS n FROM memory_session_index_state;')).toBe(0);
    expect(countRows(deepDbPath, 'SELECT COUNT(*) AS n FROM message_chunks;')).toBe(0);
    expect(countRows(deepDbPath, 'SELECT COUNT(*) AS n FROM chunk_embeddings;')).toBe(0);
    const cleared = openDeepIndexDb({ dbPath: deepDbPath });
    expect(cleared.listExternalSourceStates()).toEqual([]);
    cleared.close();
    await Promise.all([worker.clearIndex(), worker.clearIndex()]);
    expect(worker.getSettings()).toMatchObject({ enabled: true, conversationSearch });
    expect(worker.getDeepDbPath()).toBe(deepDbPath);
    expect(worker.listIndexedSessionIds()).toEqual([]);
    expect(await readFile(modelMarker, 'utf8')).toBe('retained model');
    const beforeInvalidWrite = worker.getSettings();
    await expect(manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET}`, params: {
      ...beforeInvalidWrite, conversationSearch: { ...conversationSearch, indexExternal: { ...conversationSearch.indexExternal, historyDays: -1 } },
    } })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(worker.getSettings()).toEqual(beforeInvalidWrite);
    await expect(manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`, params: {} }))
      .resolves.toEqual(beforeInvalidWrite);
  });

  it('preserves a pending settings reload when clear resumes the worker', async () => {
    const { worker, writeMemorySettingsToDisk } = await startSeededWorker();
    const saved = await writeMemorySettingsToDisk({ ...worker.getSettings(), enabled: false,
      conversationSearch: { standardSearch: { enabled: false } } });
    const persistence = await import('@/persistence');
    const readSettings = persistence.readSettings;
    let releaseRead!: () => void;
    let startedRead!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    const started = new Promise<void>((resolve) => { startedRead = resolve; });
    // Delay one filesystem-backed settings read, not its normalization/lifecycle.
    vi.spyOn(persistence, 'readSettings').mockImplementationOnce(async () => {
      const value = await readSettings();
      startedRead();
      await blocked;
      return value;
    });
    const reloading = worker.reloadSettings();
    await started;
    const clearing = worker.clearIndex();
    releaseRead();
    await Promise.all([reloading, clearing]);
    expect(worker.getSettings()).toEqual(saved);
    expect(worker.getDeepDbPath()).toBeNull();
  });

  it('keeps the external index available when Memory uses hints', async () => {
    const { worker, deepDbPath, writeMemorySettingsToDisk } = await startSeededWorker();
    const settings = worker.getSettings();
    await writeMemorySettingsToDisk({ ...settings, indexMode: 'hints',
      hints: { ...settings.hints, enabled: false },
      conversationSearch: { ...settings.conversationSearch,
        indexExternal: { ...settings.conversationSearch.indexExternal, enabled: true } },
    });
    await worker.reloadSettings();
    expect(worker.getDeepDbPath()).toBe(deepDbPath);
    // Native conversations use the existing deep store, not hints summarization.
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const db = openDeepIndexDb({ dbPath: worker.getDeepDbPath()! });
    try { expect(db.listIndexedSessionIds()).toContain('kept'); }
    finally { db.close(); }
  });

  async function runDisabledRemoval(event: RemovalEvent): Promise<void> {
    const { worker, tier1DbPath, deepDbPath, writeMemorySettingsToDisk } = await startSeededWorker();
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: false,
      indexMode: 'deep',
      backfillPolicy: 'all_history',
      deleteOnDisable: false,
    });
    await worker.reloadSettings();
    expect(worker.getTier1DbPath()).toBeNull();
    expect(worker.getDeepDbPath()).toBeNull();

    const deleted = createSource<{ sessionId: string }>();
    const revoked = createSource<{ sessionId: string }>();
    const reset = createSource<{ cursor: number }>();
    const archived = createSource<{ sessionId: string; archived: boolean }>();
    const { subscribeMemorySessionRemoval } = await import('./subscribeMemorySessionRemoval');
    const dispose = subscribeMemorySessionRemoval({
      memoryWorker: worker,
      onSessionDeletedChange: deleted.subscribe,
      onSessionAccessRevoked: revoked.subscribe,
      onSessionAccessReset: reset.subscribe,
      onSessionArchivedStateChange: archived.subscribe,
    });

    if (event === 'deleted') await deleted.emit({ sessionId: 'gone' });
    if (event === 'revoked') await revoked.emit({ sessionId: 'gone' });
    if (event === 'reset') await reset.emit({ cursor: 7 });

    // Event completion is the custody boundary: retained disk state must
    // already be purged before the source is allowed to acknowledge it.
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const disabledTier1 = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    const disabledDeep = openDeepIndexDb({ dbPath: deepDbPath });
    expect(disabledTier1.listIndexedSessionIds()).toEqual(['kept']);
    expect(disabledDeep.listIndexedSessionIds()).toEqual(['kept']);
    disabledTier1.close();
    disabledDeep.close();
    expect(countRows(tier1DbPath, 'SELECT COUNT(*) AS n FROM session_cursors WHERE sessionId = ?;', 'gone')).toBe(0);
    expect(countRows(tier1DbPath, 'SELECT COUNT(*) AS n FROM memory_session_index_state WHERE sessionId = ?;', 'gone')).toBe(0);
    expect(countRows(deepDbPath, 'SELECT COUNT(*) AS n FROM message_chunks WHERE sessionId = ?;', 'gone')).toBe(0);
    expect(countRows(deepDbPath, 'SELECT COUNT(*) AS n FROM chunk_embeddings WHERE sessionId = ?;', 'gone')).toBe(0);

    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'deep',
      backfillPolicy: 'all_history',
      deleteOnDisable: false,
    });
    await worker.reloadSettings();

    const { searchTier1Memory, searchTier2Memory } = await import('./searchMemory');
    const query = {
      v: 1 as const,
      query: 'retained',
      scope: { type: 'global' as const },
      mode: 'auto' as const,
      maxResults: 10,
    };
    const tier1Result = searchTier1Memory({ dbPath: tier1DbPath, query });
    const deepResult = await searchTier2Memory({ dbPath: deepDbPath, query, previewChars: 200 });
    expect(tier1Result.ok && tier1Result.hits.map((hit) => hit.type === undefined ? hit.sessionId : null)).toEqual(['kept']);
    expect(deepResult.ok && deepResult.hits.map((hit) => hit.type === undefined ? hit.sessionId : null)).toEqual(['kept']);
    dispose();
  }

  it('purges a deleted Session while memory is disabled before search can be re-enabled', async () => {
    await runDisabledRemoval('deleted');
  });

  it('purges an access-revoked Session while memory is disabled before search can be re-enabled', async () => {
    await runDisabledRemoval('revoked');
  });

  it('reconciles retained Session access on cursor reset while memory is disabled', async () => {
    await runDisabledRemoval('reset');
  });
});
