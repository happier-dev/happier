import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMemorySessionListVisibilityFixture } from './testkit/startMemoryWorker';
import { mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createCompactSessionListRowFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { Credentials, StoredCredentials } from '@/persistence';
import nacl from 'tweetnacl';
import { encodeBase64, encryptLegacy } from '@/api/encryption';

// Transform the shared API graph outside the per-operation workload deadline.
await import('@/api/api');
await import('./testkit/inProcessMemoryIndexer');

// Configuration exposes the process role read-only; these specs flip it to
// exercise daemon-only scheduling inside one worker lifetime.
function setDaemonProcess(configuration: { readonly isDaemonProcess: boolean }, value: boolean): void {
  Object.assign(configuration, { isDaemonProcess: value });
}

describe('memoryWorker', () => {
  it('wakes selected native-source observation only for its declared Account keys', async () => {
    const { accountSettingsParse } = await import('@happier-dev/protocol/account/settings/accountSettings');
    const { normalizeMemorySettings } = await import('@happier-dev/protocol/memory/memorySettings');
    const account = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
    const { createMemoryExternalTranscriptObservation } = await import('./externalTranscriptObservation');
    account.resetActiveAccountSettingsSnapshotForTests();
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: ['happier.agent.pi'] } });
    const base = { source: 'network' as const, scopeKey: 'memory-native-account', settingsVersion: 1,
      loadedAtMs: 1, settings: accountSettingsParse({}), settingsSecretsReadKeys: [] };
    account.setActiveAccountSettingsSnapshot(base);
    const changed = vi.fn();
    const observation = createMemoryExternalTranscriptObservation({ credentials: { token: 'fixture', encryption: null }, onChange: changed });
    try {
      await observation.configure(normalizeMemorySettings({ v: 1, enabled: true,
        conversationSearch: { indexExternal: { enabled: true, agents: ['pi'] } } }), normalizeMemorySettings({ v: 1 }));
      for (let index = 0; index < 25; index++) account.setActiveAccountSettingsSnapshot({ ...base,
        settingsVersion: index + 2, settings: accountSettingsParse({ analyticsOptOut: index % 2 === 0 }) });
      expect(changed).not.toHaveBeenCalled();
      account.setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 27,
        settings: accountSettingsParse({ piAgentDir: '/memory-native-source' }) });
      expect(changed).toHaveBeenCalledOnce();
    } finally { await observation.dispose(); await runtime.dispose(); account.resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('does not send indexer work for 25 unrelated Account preference writes', async () => {
    const { accountSettingsParse } = await import('@happier-dev/protocol/account/settings/accountSettings');
    const account = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    account.resetActiveAccountSettingsSnapshotForTests();
    const base = { source: 'network' as const, scopeKey: 'memory-account', settingsVersion: 1,
      loadedAtMs: 1, settings: accountSettingsParse({}), settingsSecretsReadKeys: [] };
    account.setActiveAccountSettingsSnapshot(base);
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep',
      embeddings: { mode: 'custom', custom: { kind: 'openai_compatible', baseUrl: 'https://embedding.test/v1', model: 'test' } } });
    const { startMemoryWorker } = await import('./memoryWorker');
    const { connectInProcessMemoryIndexer } = await import('./testkit/inProcessMemoryIndexer');
    const credentials: StoredCredentials = { token: 'fixture', encryption: null };
    let retries = 0;
    const worker = await startMemoryWorker({ credentials, machineId: 'machine_1', deps: {
      connectIndexer: async host => {
        const connection = await connectInProcessMemoryIndexer({ credentials, machineId: 'machine_1', host });
        // Observe messages at the OS indexer-placement boundary, preserving its real implementation.
        return { ...connection, retryEmbeddings: async signal => { retries++; await connection.retryEmbeddings(signal); } };
      },
    } });
    try {
      const initial = retries;
      for (let index = 0; index < 25; index++) account.setActiveAccountSettingsSnapshot({ ...base,
        settingsVersion: index + 2, settings: accountSettingsParse({ analyticsOptOut: index % 2 === 0 }) });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(retries).toBe(initial);
      account.setActiveAccountSettingsSnapshot({ ...base, settingsVersion: 27, source: 'cache' });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(retries).toBe(initial);
    } finally { await worker.stop(); account.resetActiveAccountSettingsSnapshotForTests(); }
  });
  it.each(['new_only', 'all_history'] as const)('keeps idle 6/6/5 readiness stable when only Session metadata changes (%s)', async backfillPolicy => {
    // The process logger's delayed file flush is not owned by worker.stop().
    // This fake-timer fixture deletes its home immediately after worker shutdown.
    applyEnvValues({ HAPPIER_LOG_LEVEL: 'silent' });
    const session = { id: 'metadata-tail', machineId: 'machine_1', seq: 6, createdAt: 2000, updatedAt: 3000,
      active: true, activeAt: 3000, archivedAt: null, encryptionMode: 'plain' };
    let sessionGate: Promise<void> | null = null;
    let sessionEntered = () => {};
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => ({
        sessions: archivedOnly ? [] : [{ ...session }], nextCursor: null, hasNext: false,
      }),
      fetchSessionById: async ({ sessionId }: { sessionId: string }) => {
        if (sessionId !== session.id) return null;
        if (sessionGate) { sessionEntered(); await sessionGate; }
        return { ...session };
      },
    }));
    let text = 'quartz retained reply';
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async ({ afterSeq, roles }: { afterSeq?: number; roles?: readonly string[] }) => ({
        messages: [
          { id: 'reply', seq: 5, createdAt: 2000, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text } } } },
          { id: 'event', seq: 6, createdAt: 2001, messageRole: 'event',
            content: { t: 'plain', v: { role: 'event', content: { type: 'event', data: { type: 'turn-end' } } } } },
        ].filter(row => row.seq > (afterSeq ?? 0) && (!roles || roles.includes(row.messageRole))),
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      }),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, enabledAtMs: 1000, indexMode: 'deep', backfillPolicy,
      coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 },
      worker: { inventoryRefreshIntervalMs: 5000, tickIntervalMs: 60_000 } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    const { configuration } = await import('@/configuration');
    const previousDaemon = configuration.isDaemonProcess;
    let releaseSession = () => {};
    let metadataChange: Promise<void> | undefined;
    try {
      await worker.ensureUpToDate(session.id);
      await worker.ensureUpToDate(session.id);
      const initial = worker.getWorkerStatus();
      expect(initial).toMatchObject({ state: 'idle', activeOperations: [],
        sessionProgress: [{ sessionId: session.id, observedSeq: 6, checkedSeq: 6, indexedSeq: 5 }] });
      // Hold only the changed Session's authorized HTTP read. Metadata alone
      // must not withdraw the retained transcript coverage or admit a tick.
      setDaemonProcess(configuration, true);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await worker.reloadSettings();
      await vi.waitFor(() => expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', currentPhase: null, activeOperations: [] }));
      session.updatedAt++;
      sessionGate = new Promise<void>(resolve => { releaseSession = resolve; });
      const entered = new Promise<void>(resolve => { sessionEntered = resolve; });
      metadataChange = worker.noteSessionChanged!({ sessionId: session.id });
      await entered;
      await vi.waitFor(() => expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', currentPhase: null, activeOperations: [] }));
      const before = worker.getWorkerStatus();
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: session.id }, state: 'ready' });
      releaseSession();
      await metadataChange;
      await vi.waitFor(() => expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', currentPhase: null, activeOperations: [] }));
      const after = worker.getWorkerStatus();
      expect(after.sessionProgress).toEqual(initial.sessionProgress);
      expect(after.lastTickAtMs).toBe(before.lastTickAtMs);
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: session.id }, state: 'ready' });
      sessionGate = null;
      setDaemonProcess(configuration, previousDaemon);
      // The direct Session path consumes the same metadata contract.
      session.updatedAt++;
      await worker.ensureUpToDate(session.id);
      text = 'sapphire revised reply';
      await worker.noteSessionTranscriptRevised?.({ sessionId: session.id, seq: 5, messageId: 'reply' });
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: session.id }, state: 'indexing' });
      await worker.ensureUpToDate(session.id);
      const { searchTier2Memory } = await import('./searchMemory');
      const result = await searchTier2Memory({ dbPath: worker.getDeepDbPath()!,
        query: { v: 1, query: 'sapphire', scope: { type: 'session', sessionId: session.id }, mode: 'deep' }, previewChars: 240 });
      expect(result.ok && result.hits).toHaveLength(1);
      const stale = await searchTier2Memory({ dbPath: worker.getDeepDbPath()!,
        query: { v: 1, query: 'quartz', scope: { type: 'session', sessionId: session.id }, mode: 'deep' }, previewChars: 240 });
      expect(stale.ok && stale.hits).toEqual([]);
      expect(worker.getWorkerStatus().sessionProgress).toEqual(initial.sessionProgress);
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: session.id }, state: 'ready' });
    } finally {
      releaseSession();
      await Promise.allSettled([metadataChange]);
      await worker.stop();
      setDaemonProcess(configuration, previousDaemon);
      vi.useRealTimers();
    }
  });
  it.each(['new_only', 'all_history'] as const)('keeps a checked 6/5 event-tail Session ready while another Session in the %s batch is reading', async backfillPolicy => {
    const covered = { id: 'event-tail', machineId: 'machine_1', seq: 6, createdAt: 2000, updatedAt: 3000,
      active: true, activeAt: 3000, archivedAt: null, encryptionMode: 'plain' };
    const pending = { ...covered, id: 'pending', seq: 1 };
    let includePending = false;
    let releasePending!: () => void;
    const held = new Promise<void>(resolve => { releasePending = resolve; });
    let pendingReadStarted = false;
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => ({
        sessions: archivedOnly ? [] : includePending ? [covered, pending] : [covered], nextCursor: null, hasNext: false,
      }),
      fetchSessionById: async ({ sessionId }: { sessionId: string }) => sessionId === covered.id ? covered : pending,
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async ({ sessionId, afterSeq, roles }: { sessionId: string; afterSeq?: number; roles?: readonly string[] }) => {
        if (sessionId === pending.id) { pendingReadStarted = true; await held; }
        const messages = sessionId === covered.id ? [
          { id: 'reply', seq: 5, createdAt: 2000, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'quartz retained reply' } } } },
          { id: 'event', seq: 6, createdAt: 2001, messageRole: 'event',
            content: { t: 'plain', v: { role: 'event', content: { type: 'event', data: { type: 'turn-end' } } } } },
        ].filter(row => row.seq > (afterSeq ?? 0) && (!roles || roles.includes(row.messageRole))) : [];
        return { messages, hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
      },
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, enabledAtMs: 1000, indexMode: 'deep', backfillPolicy,
      coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    let refresh: Promise<void> | undefined;
    try {
      await worker.ensureUpToDate(covered.id);
      await worker.ensureUpToDate(covered.id);
      const { MemoryWorkerStatusV1Schema } = await import('@happier-dev/protocol/memory/memoryStatus');
      expect(MemoryWorkerStatusV1Schema.parse(worker.getWorkerStatus())).toMatchObject({
        sessionProgress: [{ sessionId: covered.id, observedSeq: 6, checkedSeq: 6, indexedSeq: 5 }],
        activeOperations: [],
      });
      expect(worker.getIndexSources?.().find(row => row.source.type === 'happier_session' && row.source.sessionId === covered.id)?.state).toBe('ready');
      includePending = true;
      refresh = worker.ensureUpToDate();
      while (!pendingReadStarted) {
        for (let turn = 0; turn < 16 && !pendingReadStarted; turn++) {
          MemoryWorkerStatusV1Schema.parse(worker.getWorkerStatus());
          await Promise.resolve();
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(worker.getIndexSources?.().find(row => row.source.type === 'happier_session' && row.source.sessionId === covered.id)?.state).toBe('ready');
      expect(MemoryWorkerStatusV1Schema.parse(worker.getWorkerStatus()).activeOperations).toEqual([
        { kind: 'transcript', sessionIds: [pending.id] },
      ]);
    } finally { releasePending(); await refresh; await worker.stop(); }
  });
  it.each([
    { observed: 3, indexed: 5, backfillPolicy: 'new_only' as const },
    { observed: 7, indexed: 6, backfillPolicy: 'new_only' as const },
    { observed: 7, indexed: 6, backfillPolicy: 'all_history' as const },
  ])('keeps an exhausted active Session ready across non-message inventory refreshes ($backfillPolicy $observed/$indexed)', async ({ observed, indexed, backfillPolicy }) => {
    const session = { id: 'exhausted', machineId: 'machine_1', seq: observed, createdAt: 2000, updatedAt: 3000,
      active: true, activeAt: 3000, archivedAt: null, encryptionMode: 'plain' };
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => ({
        sessions: archivedOnly ? [] : [session], nextCursor: null, hasNext: false,
      }),
      fetchSessionById: async () => session,
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => {
        return { messages: [{ id: 'message', seq: indexed, createdAt: 2000, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'quartz retained message' } } } }],
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
      },
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, enabledAtMs: 1000, indexMode: 'deep', backfillPolicy,
      coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1', deps: {
      fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }) => {
        return afterSeq < indexed ? [{ seq: indexed, createdAtMs: 2000, role: 'user',
          content: { type: 'text', text: 'quartz retained message' } }] : [];
      },
    } });
    try {
      await worker.ensureUpToDate(session.id);
      await worker.ensureUpToDate(session.id);
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: session.id }, state: 'ready' });
      const states = new Set<string>();
      for (let refresh = 0; refresh < 3; refresh++) {
        session.activeAt++;
        let completed = false;
        const pending = worker.ensureUpToDate(session.id).finally(() => { completed = true; });
        while (!completed) {
          for (let turn = 0; turn < 16 && !completed; turn++) {
            for (const source of worker.getIndexSources!()) states.add(source.state);
            await Promise.resolve();
          }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        await pending;
      }
      expect([...states]).toEqual(['ready']);
    } finally { await worker.stop(); }
  });
  it('keeps a completed unchanged snapshot without refetching its body, but indexes revisions and new sequences', async () => {
    const session = { id: 'snapshot', machineId: 'machine_1', seq: 10, createdAt: 2000, updatedAt: 3000,
      active: false, activeAt: 0, archivedAt: null, encryptionMode: 'plain' };
    let text = `quartz ${'valid body '.repeat(10_000)}`;
    let messageSeq = 1;
    let fetchedBytes = 0;
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => ({ sessions: archivedOnly ? [] : [session], nextCursor: null, hasNext: false }),
      fetchSessionById: async () => session,
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => {
        fetchedBytes += Buffer.byteLength(text);
        return { messages: [{ id: 'message', seq: messageSeq, createdAt: 2000, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text } } } }],
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
      },
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, enabledAtMs: 1000, indexMode: 'deep', backfillPolicy: 'new_only',
      coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    try {
      await worker.ensureUpToDate('snapshot');
      fetchedBytes = 0;
      const started = performance.now();
      const observedStates = new Set<string>();
      for (let tick = 0; tick < 3; tick++) {
        let complete = false;
        const refresh = worker.ensureUpToDate('snapshot').finally(() => { complete = true; });
        while (!complete) {
          // Observe the published coverage during the real refresh, including
          // the microtasks between admission and a no-op transcript turn.
          for (let turn = 0; turn < 16 && !complete; turn++) {
            for (const row of worker.getIndexSources!()) observedStates.add(row.state);
            await Promise.resolve();
          }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        await refresh;
      }
      console.info('R237_UNCHANGED_SNAPSHOT', JSON.stringify({ fetchedBytes, elapsedMs: performance.now() - started }));
      expect(fetchedBytes).toBe(0);
      expect([...observedStates]).toEqual(['ready']);
      const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
      const db = openDeepIndexDb({ dbPath: worker.getDeepDbPath()! });
      try {
        expect(db.search({ query: 'quartz', scope: { type: 'session', sessionId: 'snapshot' }, maxResults: 1 })).toHaveLength(1);
        text = 'garnet revised at the same sequence';
        await worker.noteSessionTranscriptRevised?.({ sessionId: 'snapshot', seq: 1 });
        await worker.ensureUpToDate('snapshot');
        expect(db.search({ query: 'garnet', scope: { type: 'session', sessionId: 'snapshot' }, maxResults: 1 })).toHaveLength(1);
        session.seq = 11;
        messageSeq = 2;
        text = 'sapphire next sequence';
        await worker.ensureUpToDate('snapshot');
        expect(db.search({ query: 'sapphire', scope: { type: 'session', sessionId: 'snapshot' }, maxResults: 1 })).toHaveLength(1);
        const current = worker.getSettings();
        await writeMemorySettingsToDisk({ ...current, deep: { ...current.deep, includeToolOutput: true } });
        await worker.ensureUpToDate('snapshot');
        expect(db.search({ query: 'sapphire', scope: { type: 'session', sessionId: 'snapshot' }, maxResults: 1 })).toHaveLength(1);
      } finally { db.close(); }
    } finally { await worker.stop(); }
  });
  it('finishes retained snapshot revisions without restarting the scheduling cursor on a later Session observation', async () => {
    let inventoryReads = 0;
    const transcriptReads = new Map<string, { selected: number; legacy: number }>();
    const sessions = Array.from({ length: 16 }, (_, index) => ({ id: `retained-${index}`, machineId: 'machine_1',
      seq: 4, createdAt: 2000, updatedAt: 3000, active: false, activeAt: 0, archivedAt: null, encryptionMode: 'plain' }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => {
        inventoryReads++;
        return { sessions: archivedOnly ? [] : sessions, nextCursor: null, hasNext: false };
      },
      fetchSessionById: async ({ sessionId }: { sessionId: string }) => sessions.find(row => row.id === sessionId),
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async ({ sessionId, roles }: { sessionId: string; roles?: readonly string[] }) => {
        const reads = transcriptReads.get(sessionId) ?? { selected: 0, legacy: 0 };
        if (roles) reads.selected += 1;
        else reads.legacy += 1;
        transcriptReads.set(sessionId, reads);
        return { messages: [{ id: `message-${sessionId}`, seq: 4, createdAt: 2000, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `garnet revised ${sessionId}` } } } }],
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
      },
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const settings = await writeMemorySettingsToDisk({ v: 1, enabled: true, enabledAtMs: 1000, indexMode: 'deep', backfillPolicy: 'new_only',
      coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 },
      worker: { tickIntervalMs: 500, inventoryRefreshIntervalMs: 5000, maxSessionsPerTick: 1 } });
    const { configuration } = await import('@/configuration');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { openDeepIndexDb, openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
    const db = openSummaryShardIndexDb({ dbPath: resolveMemoryIndexPaths().tier1DbPath });
    const deep = openDeepIndexDb({ dbPath: resolveMemoryIndexPaths().deepDbPath });
    const { memoryIndexPolicyKey, resolveMemoryIndexPolicy } = await import('./transcript/coveragePolicy');
    const key = memoryIndexPolicyKey(resolveMemoryIndexPolicy(settings));
    db.setIndexPolicyKeys({ tier1: key, deep: key, external: JSON.stringify(settings.conversationSearch.indexExternal) });
    for (const session of sessions) {
      db.markDeepIndexSuccess({ sessionId: session.id, seqTo: 4, nowMs: Date.now() });
      db.recordMemorySessionIndexState({ sessionId: session.id, status: 'indexed', lastScannedSeq: 4, updatedAtMs: Date.now() });
      deep.insertChunk({ sessionId: session.id, seqFrom: 4, seqTo: 4,
        createdAtFromMs: 2000, createdAtToMs: 2000, text: 'quartz stale retained projection', policyKey: key });
    }
    db.close(); deep.close();
    const previousDaemon = configuration.isDaemonProcess;
    setDaemonProcess(configuration, true);
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    try {
      expect(worker.getSettings().worker.tickIntervalMs).toBe(500);
      expect(worker.getSettings().worker.inventoryRefreshIntervalMs).toBe(5000);
      expect(worker.getSettings().worker.maxSessionsPerTick).toBe(1);
      expect(worker.getSettings().deep.minChunkMessages).toBe(1);
      // A demand now drains admitted revisions before settling; an intermediate
      // indexing snapshot need not remain observable after startup returns.
      await vi.waitFor(() => {
        expect(transcriptReads.size).toBe(sessions.length);
        expect(worker.getIndexSources?.()).toHaveLength(sessions.length);
        expect(worker.getIndexSources?.().filter(row => row.state !== 'ready')).toEqual([]);
      }, { timeout: 15_000 });
      const current = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
      try {
        for (const session of sessions) {
          const scope = { type: 'session' as const, sessionId: session.id };
          const fresh = current.search({ query: 'garnet', scope, maxResults: 1 });
          expect(fresh, JSON.stringify({ sessionId: session.id, reads: transcriptReads.get(session.id),
            stats: current.getDeepIndexStats(), enabledAtMs: worker.getSettings().enabledAtMs,
            contentPolicy: worker.getSettings().contentPolicy,
            progress: worker.getWorkerStatus().sessionProgress?.find(row => row.sessionId === session.id),
            stale: current.search({ query: 'quartz', scope, maxResults: 1 }) })).toHaveLength(1);
          expect(current.search({ query: 'quartz', scope: { type: 'session', sessionId: session.id }, maxResults: 1 })).toEqual([]);
          // The canonical semantic reader performs one selected-role query and
          // one legacy-unclassified fallback query for each source snapshot.
          expect(transcriptReads.get(session.id)).toEqual({ selected: 1, legacy: 1 });
        }
      } finally { current.close(); }
      const completedInventoryReads = inventoryReads;
      sessions[0]!.updatedAt++;
      await worker.noteSessionChanged!({ sessionId: sessions[0]!.id });
      await vi.waitFor(() => expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', activeOperations: [] }));
      expect(inventoryReads).toBe(completedInventoryReads);
      expect(worker.getIndexSources?.().filter(row => row.state !== 'ready')).toEqual([]);
      expect([...transcriptReads.values()]).toEqual(sessions.map(() => ({ selected: 1, legacy: 1 })));
    } finally { await worker.stop(); setDaemonProcess(configuration, previousDaemon); }
  });
  it('publishes a retained queue failure code without exposing its private message', async () => {
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep' });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    try {
      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const db = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPath()! });
      db.markDeepIndexFailure({ sessionId: 'failed', nowMs: Date.now(), backoffBaseMs: 1000, backoffMaxMs: 1000 });
      db.recordMemorySessionIndexState({ sessionId: 'failed', status: 'failed', lastErrorCode: 'deep_index_failed',
        lastErrorMessage: 'private transcript /path', updatedAtMs: Date.now() });
      const { externalMemoryStorageId } = await import('./externalTranscriptIndex');
      const nativeId = externalMemoryStorageId({ type: 'external_transcript', agentId: 'codex', sourceKey: 'local', nativeSessionId: 'native' });
      db.markDeepIndexFailure({ sessionId: nativeId, nowMs: Date.now(), backoffBaseMs: 1000, backoffMaxMs: 1000 });
      db.close();
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'failed' },
        state: 'error', errorCode: 'deep_index_failed' });
      expect(worker.listIndexedSessionIds()).not.toContain(nativeId);
      expect(worker.getIndexSources?.()).not.toContainEqual(expect.objectContaining({ source: { type: 'happier_session', sessionId: nativeId } }));
    } finally { await worker.stop(); }
  });
  it('reads status without joining an index writer or mutating its cursor', async () => {
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    const { openSqliteDatabaseSync } = await import('../persistence/sqliteSync');
    const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
    const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
    const { MemoryStatusV1Schema } = await import('@happier-dev/protocol/memory/memoryStatus');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const retained = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPath()! });
    retained.recordMemorySessionIndexState({ sessionId: 'retained', status: 'empty', updatedAtMs: Date.now() });
    retained.getSessionCursors({ sessionId: 'retained', nowMs: Date.now() });
    retained.close();
    const writer = openSqliteDatabaseSync(worker.getTier1DbPath()!);
    const deepWriter = openSqliteDatabaseSync(worker.getDeepDbPath()!);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
    registerMachineMemoryRpcHandlers({ rpcHandlerManager: manager, memoryWorker: worker });
    writer.exec('BEGIN IMMEDIATE');
    deepWriter.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    try {
      // SQLite WAL permits this read while another connection owns the writer.
      // Reopening schema/migration code or ensuring a cursor tries to write.
      const result = await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`, params: {} });
      console.info('R233_STATUS_LOCK', JSON.stringify({ elapsedMs: performance.now() - started,
        readable: MemoryStatusV1Schema.safeParse(result).success }));
      expect(MemoryStatusV1Schema.parse(result).sources).toContainEqual({
        source: { type: 'happier_session', sessionId: 'retained' }, state: 'ready',
      });
      expect(MemoryStatusV1Schema.parse(result).worker).toMatchObject({ activeOperations: [],
        sessionProgress: [{ sessionId: 'retained', observedSeq: null, checkedSeq: 0, indexedSeq: 0 }] });
    } finally { writer.exec('ROLLBACK'); deepWriter.exec('ROLLBACK'); writer.close(); deepWriter.close(); await worker.stop(); }
  });
  it.each(['empty', 'indexed'] as const)('publishes completed %s queue coverage when the inventory sequence includes non-message events', async status => {
    let transcriptReads = 0;
    let releaseRead = () => {};
    let readStarted = () => {};
    const held = new Promise<void>(resolve => { releaseRead = resolve; });
    const entered = new Promise<void>(resolve => { readStarted = resolve; });
    const session = { id: 'covered', machineId: 'machine_1', seq: 7, createdAt: 1000, updatedAt: 2000,
      active: false, activeAt: 0, archivedAt: null, encryptionMode: 'plain' };
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => ({ sessions: archivedOnly ? [] : [session], nextCursor: null, hasNext: false }),
      fetchSessionById: async () => { readStarted(); await held; return session; },
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => {
        transcriptReads += 1;
        return { messages: status === 'indexed' ? [{ id: 'covered-message',
        seq: 1, createdAt: 1000, messageRole: 'user', content: { t: 'plain',
          v: { role: 'user', content: { type: 'text', text: 'quartz completed coverage' } } } }] : [],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
      },
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
      coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const initialWorker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    const tier1DbPath = initialWorker.getTier1DbPath()!;
    await initialWorker.stop();
    // Retained rows must predate startup admission, as they do after a real restart.
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const db = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    // Retained qa-r232 shape: source metadata observed a later sequence,
    // while the completed transcript scan has no remaining message rows.
    db.markDeepIndexSuccess({ sessionId: 'covered', seqTo: status === 'indexed' ? 1 : 0, nowMs: Date.now() });
    db.recordMemorySessionIndexState({ sessionId: 'covered', status, lastObservedSeq: 7, updatedAtMs: Date.now() });
    db.close();
    const { openSqliteDatabaseSync } = await import('../persistence/sqliteSync');
    const fixture = openSqliteDatabaseSync(tier1DbPath);
    fixture.exec("UPDATE session_cursors SET lastObservedSeq=7 WHERE sessionId='covered'");
    fixture.close();
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1' });
    let revision: Promise<void> | undefined;
    let refresh: Promise<void> | undefined;
    try {
      expect(worker.getSettings()).toMatchObject({ backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'covered' }, state: 'ready' });
      revision = worker.noteSessionTranscriptRevised?.({ sessionId: 'covered', seq: 7 });
      await revision;
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'covered' }, state: 'indexing' });
      refresh = worker.ensureUpToDate('covered');
      await entered;
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'covered' }, state: 'indexing' });
      releaseRead(); await refresh;
      expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'covered' }, state: 'ready' });
      expect(worker.getWorkerStatus().sessionProgress).toMatchObject([{ sessionId: 'covered', observedSeq: 7, checkedSeq: 7 }]);
      const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
      const current = openDeepIndexReader({ dbPath: worker.getDeepDbPath()! });
      try {
        expect(current.search({ query: 'quartz', scope: { type: 'session', sessionId: 'covered' }, maxResults: 1 }),
          JSON.stringify({ transcriptReads, stats: current.getDeepIndexStats(),
            progress: worker.getWorkerStatus().sessionProgress, enabledAtMs: worker.getSettings().enabledAtMs }))
          .toHaveLength(status === 'indexed' ? 1 : 0);
      } finally { current.close(); }
    } finally { releaseRead(); await Promise.allSettled([revision, refresh]); await worker.stop(); }
  });
  it('publishes Session readiness only after the latest observed cursor and revisions are indexed', async () => {
    let resume = () => {};
    let started = () => {};
    let deferred: Promise<void> | null = null;
    let text = 'quartz';
    let snapshotReads = 0;
    let incrementalReads = 0;
    const session = { id: 'local', machineId: 'machine_1', seq: 1, createdAt: 1000, updatedAt: 2000,
      active: false, activeAt: 0, archivedAt: null, encryptionMode: 'plain' };
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      // This Session is not archived. Returning it from the archived-only
      // visibility read would make settings admission reconcile a false change.
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => ({
        sessions: archivedOnly ? [] : [session], nextCursor: null, hasNext: false,
      }),
      fetchSessionById: async () => session,
    }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => {
        snapshotReads += 1;
        const snapshotText = text;
        if (deferred) { started(); await deferred; }
        return { messages: [{ id: 'message', seq: 1, createdAt: 1000,
        messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: snapshotText } } } }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
      },
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
      coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 't', encryption: null }, machineId: 'machine_1', deps: {
      fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }) => {
        incrementalReads += 1;
        const snapshotText = text;
        if (deferred) { started(); await deferred; }
        return afterSeq < 1 ? [{ seq: 1, createdAtMs: 1000, role: 'user', content: { type: 'text', text: snapshotText } }] : [];
      },
    } });
    let revision: Promise<void> | undefined;
    let syncing: Promise<void> | undefined;
    try {
      expect(worker.getSettings()).toMatchObject({ backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
      await worker.ensureUpToDate('local');
      const source = { type: 'happier_session', sessionId: 'local' };
      expect(worker.getIndexSources?.()).toEqual([{ source, state: 'ready' }]);
      text = 'garnet revised';
      deferred = new Promise(resolve => { resume = resolve; });
      const revisionEntered = new Promise<void>(resolve => { started = resolve; });
      revision = worker.noteSessionTranscriptRevised?.({ sessionId: 'local', seq: 1 });
      await revision;
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'indexing' });
      syncing = worker.ensureUpToDate('local');
      await revisionEntered;
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'indexing' });
      resume(); await syncing; deferred = null;
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'ready' });
      session.seq = 2;
      deferred = new Promise(resolve => { resume = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      syncing = worker.ensureUpToDate('local');
      await entered;
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'indexing' });
      text = 'sapphire revised while reading';
      revision = worker.noteSessionTranscriptRevised?.({ sessionId: 'local', seq: 1 });
      await revision;
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'indexing' });
      resume(); await syncing; deferred = null;
      await worker.ensureUpToDate('local');
      expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'ready' });
      expect(worker.getWorkerStatus().sessionProgress).toMatchObject([{ sessionId: 'local', observedSeq: 2, checkedSeq: 2 }]);
      const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
      const current = openDeepIndexReader({ dbPath: worker.getDeepDbPath()! });
      try {
        expect(current.search({ query: 'sapphire', scope: { type: 'session', sessionId: 'local' }, maxResults: 1 }),
          JSON.stringify({ snapshotReads, incrementalReads, stats: current.getDeepIndexStats(),
            progress: worker.getWorkerStatus().sessionProgress, enabledAtMs: worker.getSettings().enabledAtMs,
            stale: current.search({ query: 'garnet', scope: { type: 'session', sessionId: 'local' }, maxResults: 1 }) }))
          .toMatchObject([{ seqFrom: 1, seqTo: 1 }]);
        expect(current.search({ query: 'garnet', scope: { type: 'session', sessionId: 'local' }, maxResults: 1 })).toEqual([]);
      } finally { current.close(); }
      await worker.clearIndex();
      expect(worker.getIndexSources?.().some(row => row.state === 'ready')).toBe(false);
    } finally { resume(); await Promise.allSettled([syncing, revision]); await worker.stop(); }
  });
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_LOG_LEVEL']);
  let homeDir: string | undefined;

  beforeEach(async () => {
    homeDir = await createTempDir('happier-memory-worker-');
    applyEnvValues({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: 'https://api.example.test',
      HAPPIER_WEBAPP_URL: 'https://app.example.test',
      // The process logger's delayed filesystem flush outlives worker.stop().
      // Keep it from recreating the test-owned home during fixture cleanup.
      HAPPIER_LOG_LEVEL: 'silent',
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

  it('observes locality once per metadata row without retaining a daemon locality memo', async () => {
    vi.useFakeTimers();
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const secret = new Uint8Array(32).fill(19);
    const sessions = ['machine_1', 'elsewhere'].map((machineId, index) => ({
      id: `locality-${index}`, seq: 0, createdAt: 1000, updatedAt: 1000, active: false, activeAt: 0,
      archivedAt: null, encryptionMode: 'e2ee', share: null,
      metadata: encodeBase64(encryptLegacy(createTestMetadata({ machineId }), secret)),
    }));
    const fetchSessionsPage = vi.fn(async () => ({ sessions, nextCursor: null, hasNext: false }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage,
      fetchSessionById: async ({ sessionId }: { sessionId: string }) => sessions.find(session => session.id === sessionId),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const { configuration } = await import('@/configuration');
    const daemonBefore = configuration.isDaemonProcess;
    setDaemonProcess(configuration, true);
    const worker = await startMemoryWorker({ credentials: { token: 't', encryption: { type: 'legacy', secret } },
      machineId: 'machine_1', deps: { fetchDecryptedTranscriptPageAfterSeq: async () => [] } });
    const opens = vi.spyOn(nacl.secretbox, 'open');
    try {
      await vi.waitFor(() => expect(fetchSessionsPage.mock.calls.length).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', activeOperations: [] }));
      const previousReads = fetchSessionsPage.mock.calls.length;
      opens.mockClear();
      const ownerBodies = sessions.map(session => Buffer.from(session.metadata, 'base64').subarray(nacl.secretbox.nonceLength));
      const localityOpens = () => opens.mock.calls.filter(([body]) => ownerBodies.some(expected => expected.equals(Buffer.from(body))));
      await vi.advanceTimersByTimeAsync(worker.getSettings().worker.inventoryRefreshIntervalMs * 2);
      expect(fetchSessionsPage.mock.calls.length).toBe(previousReads);
      expect(localityOpens()).toHaveLength(0);
      for (const session of sessions) await worker.noteSessionChanged!({ sessionId: session.id });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', activeOperations: [] }));
      expect(localityOpens()).toHaveLength(sessions.length);
      expect(fetchSessionsPage.mock.calls.length).toBe(previousReads);
    } finally { opens.mockRestore(); await worker.stop(); setDaemonProcess(configuration, daemonBefore); vi.useRealTimers(); }
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
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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

  it.each([
    { indexMode: 'deep', mode: 'deep' },
    { indexMode: 'deep', mode: 'hints' },
    { indexMode: 'hints', mode: 'hints' },
  ] as const)('indexes admitted documents and preserves $mode Session search with $indexMode indexing', async ({ indexMode, mode }) => {
    const axios = (await import('axios')).default;
    const { accountSettingsParse, MemorySearchResultV1Schema } = await import('@happier-dev/protocol');
    const { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } = await import('@happier-dev/protocol/storage/artifactStoredContent');
    const { emptyPromptLibraryRecordV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
    const { PromptLibraryCatalogKeyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
    const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
    const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const { buildSessionMetadataEnvelopeFields } = await import('@/session/metadata/buildSessionMetadataEnvelopeCreateFields');
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
    const entry = (id: string) => ({ id, ref: { kind: 'doc' as const, artifactId: id }, enabled: true, placement: 'system_append' as const, maxChars: 1 });
    let attached = ['memory', 'instructions'];
    let revision = 1;
    let readable = true;
    let replaceAccountDuringSessionRead = false;
    let retainedSourceRead: (() => Promise<void>) | undefined;
    let heldDocumentSessionRead: (() => Promise<void>) | undefined;
    let accountAttached = false;
    let projectOnly = false;
    const { configuration } = await import('@/configuration');
    const projectRef = { serverId: configuration.activeServerId, projectKey: 'project-no-session' };
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
    const session = () => {
      const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
        agentState: null, metadata: createTestMetadata({ machineId: 'machine_1',
          work: { memoryEnabled: true, promptStack: attached.map(entry) } }) });
      return { id: 's1', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 0, encryptionMode: 'plain' as const,
        metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 1, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState, agentStateVersion: 0,
        dataEncryptionKey: null, share: null };
    };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200,
        data: { sessions: path.endsWith('/archived') || projectOnly ? [] : [createCompactSessionListRowFixture(session())], nextCursor: null, hasNext: false } };
      if (path === '/v2/sessions/s1') {
        await heldDocumentSessionRead?.();
        if (replaceAccountDuringSessionRead) {
          replaceAccountDuringSessionRead = false;
          setActiveAccountSettingsSnapshot({ ...accountSnapshot, scopeKey: 'another-account' });
          setActiveAccountSettingsSnapshot(accountSnapshot);
        }
        return { status: 200, data: { session: session() } };
      }
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') {
        await retainedSourceRead?.();
        return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      }
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: accountAttached ? 2 : 1, content: { t: 'plain', v: key === 'coding' && accountAttached
        ? { key, value: { v: 1, scope: { kind: 'coding' }, entries: [entry('account-instructions')] } }
        : emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v1/artifacts') return { status: 200, data: readable ? [...attached, ...(accountAttached ? ['account-instructions'] : [])].map(artifact) : [] };
      if (path.startsWith('/v1/artifacts/')) return readable ? { status: 200, data: artifact(path.split('/').at(-1)!) } : { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected document indexing HTTP path: ${path}`);
    });
    const projectRows = (): ProjectAccountRowV1[] => projectOnly ? [{
      key: { kind: 'project-organization', ...projectRef }, revision: 1,
      content: { t: 'plain', v: { key: { kind: 'project-organization', ...projectRef }, value: { promptStack: [entry('memory')] } } },
    }] : [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions/read-batch') return { status: 200,
        data: createSessionReadBatchResponseFixture({ request: body, sessions: projectOnly ? [] : [session()] }) };
      if (path === '/v1/account/project-rows/read') return projectAccountRowReadResponse(projectRows(), body);
      if (path === '/v1/account/project-rows/list') return { status: 200,
        data: { status: 'listed', coverage: 'complete', rows: [] } };
      throw new Error(`Unexpected document indexing HTTP path: ${path}`);
    });
    // Real Session HTTP/schema parsing consumes the canonical producer's tuple.
    // Selection, metadata opening, content adapters and SQLite remain real.
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => ({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode, backfillPolicy: 'all_history' });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
    const worker = await startMemoryWorker({ credentials, machineId: 'machine_1', deps: { fetchDecryptedTranscriptPageAfterSeq: async () => [] } });
    try {
      await worker.ensureUpToDate('s1');
      expect(worker.getDeepDbPath()).toBeTruthy();
      const dbPath = worker.getDeepDbPath()!;
      const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
      const db = openDeepIndexDb({ dbPath });
      db.insertChunk({ sessionId: 's1', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, text: 'quartz session' });
      expect(db.getDeepIndexStats()).toMatchObject({ deepDocumentEntryCount: 5, searchableDocumentCount: 2 });
      db.close();
      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const summaries = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPath()! });
      summaries.insertSummaryShard({ sessionId: 's1', seqFrom: 2, seqTo: 2,
        createdAtFromMs: 2, createdAtToMs: 2, summary: 'quartz hinted session', keywords: [], entities: [], decisions: [] });
      summaries.close();
      if (indexMode === 'deep') {
        const source = { type: 'happier_session', sessionId: 's1' };
        expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'ready' });
        let release = () => {};
        let entered = () => {};
        const pending = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        heldDocumentSessionRead = async () => { entered(); await pending; };
        const admission = worker.resolveDocumentSearchScope!({ type: 'session', sessionId: 's1' });
        try {
          await started;
          expect(worker.getIndexSources?.()).toContainEqual({ source, state: 'ready' });
        } finally { release(); heldDocumentSessionRead = undefined; await admission; }
      }
      const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
      const manager = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
      registerMachineMemoryRpcHandlers({ rpcHandlerManager: manager, memoryWorker: worker });
      expect(await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`, params: null })).toMatchObject({ documentSearchSupported: true, projectSearchSupported: true });
      const { MemoryStatusV1Schema } = await import('@happier-dev/protocol/memory/memoryStatus');
      expect(MemoryStatusV1Schema.parse(await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`,
        params: { scope: { type: 'session', sessionId: 's1' } } })).documents)
        .toMatchObject({ state: 'ready', facts: [{ ref: { kind: 'doc', artifactId: 'memory' }, indexedFactCount: 4 }] });
      const search = async (corpora: ('documents' | 'sessions')[] | null = ['documents', 'sessions'], global = false) => MemorySearchResultV1Schema.parse(await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SEARCH}`, params: {
        v: 1, query: 'quartz', scope: global ? { type: 'global' } : { type: 'session', sessionId: 's1' }, mode, ...(corpora ? { corpora } : {}),
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
      expect(sessionsOnly).toMatchObject({ ok: true, hits: [expect.objectContaining({ sessionId: 's1',
        seqFrom: mode === 'hints' ? 2 : 1, summary: mode === 'hints' ? 'quartz hinted session' : 'quartz session' })] });
      expect(result.hits.filter(hit => !('type' in hit))).toEqual(sessionsOnly.ok ? sessionsOnly.hits : []);
      expect(sessionsOnly).not.toHaveProperty('documents');
      expect(await search(null)).toEqual(sessionsOnly);
      // Real Machine registration -> worker's Project context port -> canonical
      // Project row reader -> Artifact admission -> SQLite, with zero Sessions.
      projectOnly = true;
      accountAttached = true;
      const projectQuery = { v: 1, query: 'quartz', scope: { type: 'project', projectRef }, mode };
      const projectResult = MemorySearchResultV1Schema.parse(await manager.handleRequest({
        method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SEARCH}`, params: projectQuery,
      }));
      expect(projectResult).toMatchObject({ ok: true, project: { state: 'ready' }, documents: { state: 'ready' } });
      expect(projectResult.ok && projectResult.hits).toHaveLength(4);
      expect(projectResult.ok && projectResult.hits.every(hit => hit.type === 'artifact' && hit.ref.artifactId === 'memory')).toBe(true);
      const projectSessions = MemorySearchResultV1Schema.parse(await manager.handleRequest({
        method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SEARCH}`, params: { ...projectQuery, corpora: ['sessions'] },
      }));
      expect(projectSessions).toMatchObject({ ok: true, hits: [], project: { state: 'ready' } });
      readable = false;
      expect(await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SEARCH}`, params: projectQuery }))
        .toMatchObject({ ok: true, hits: [], project: { state: 'unavailable' } });
      readable = true;
      projectOnly = false;
      accountAttached = false;
      let releaseSource = () => {};
      let sourceIssued = () => {};
      const sourcePending = new Promise<void>(resolve => { releaseSource = resolve; });
      const sourceStarted = new Promise<void>(resolve => { sourceIssued = resolve; });
      // The real catalog publishes authoritative rows before optional source/history
      // maintenance. Holding that HTTP response must not hold document RPC admission.
      accountAttached = true;
      retainedSourceRead = async () => { sourceIssued(); await sourcePending; };
      let globalSettled = false;
      const globalSearch = search(['documents', 'sessions'], true).then(result => { globalSettled = true; return result; });
      try {
        await Promise.race([sourceStarted, globalSearch]);
        await vi.waitFor(() => expect(globalSettled,
          'Readable document membership must not await retained-source maintenance').toBe(true));
      } finally {
        releaseSource();
        retainedSourceRead = undefined;
        await globalSearch;
      }
      const global = await globalSearch;
      expect(global).toMatchObject({ ok: true, documents: { state: 'ready' } });
      expect(global.ok && global.hits).toHaveLength(7);
      expect(global.ok && global.hits).toContainEqual(expect.objectContaining({
        type: 'artifact', ref: expect.objectContaining({ artifactId: 'account-instructions' }),
      }));
      accountAttached = false;
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
      expect(worker.getSettings().hints.enabled).toBe(indexMode === 'hints');
      expect(worker.getEmbeddingsDiagnostics()).toMatchObject({ runtimeState: 'unavailable' });
      await writeMemorySettingsToDisk({ ...worker.getSettings(), enabled: false });
      await worker.reloadSettings();
      expect(await search(['documents'])).toMatchObject({ ok: false, errorCode: 'memory_disabled' });
      expect(await worker.resolveDocumentSearchScope!({ type: 'global' })).toMatchObject({ state: 'unavailable' });
    } finally {
      await worker.stop();
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('admits documents on demand and performs no inventory reads while idle', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.doMock('@/configuration', async () => {
      const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
      return { ...actual, configuration: { ...actual.configuration, isDaemonProcess: true } };
    });
    const { accountSettingsParse } = await import('@happier-dev/protocol');
    const { emptyPromptLibraryRecordV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
    const { PromptLibraryCatalogKeyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
    const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
    const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      scopeKey: resolveAccountSettingsScopeKey(credentials), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    let inventoryReads = 0;
    let promptReads = 0;
    const axios = (await import('axios')).default;
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/sessions') {
        inventoryReads += 1;
        return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
      }
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') {
        promptReads += 1;
        return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
          key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
        })) } };
      }
      throw new Error(`Unexpected idle Memory HTTP path: ${path}`);
    });
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ enabled: true, indexMode: 'deep', backfillPolicy: 'new_only', worker: {
      inventoryRefreshIntervalMs: 5_000, tickIntervalMs: 500, maxSessionsPerTick: 1, sessionListPageLimit: 10,
    } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const { logger } = await import('@/ui/logger');
    const diagnostics = vi.spyOn(logger, 'infoFile');
    const worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', activeOperations: [] }));
      const initialInventoryReads = inventoryReads;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(inventoryReads).toBe(initialInventoryReads);
      expect(promptReads, 'No document consumer requested admission while idle').toBe(0);
      expect(await worker.resolveDocumentSearchScope!({ type: 'global' })).toMatchObject({ state: 'ready', eligibleDocuments: [] });
      expect(promptReads).toBeGreaterThan(0);
      const admittedReads = promptReads;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(promptReads).toBe(admittedReads);
      await worker.ensureUpToDate();
      expect(promptReads).toBeGreaterThan(admittedReads);
      await worker.stop();
      // Draining the actual loops closes the false-green race where a timer
      // starts admission but has not yet reached its catalog HTTP read.
      const admissions = diagnostics.mock.calls.filter(([message]) => message === '[memoryDocuments] Admission started');
      expect(admissions, 'Only the requested scope and explicit refresh may admit documents').toHaveLength(2);
    } finally {
      await worker.stop();
      resetActiveAccountSettingsSnapshotForTests();
      vi.useRealTimers();
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
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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
        const disabling = worker?.reloadSettings();
        // The process boundary now joins terminal writer acknowledgement before
        // deleting the cache. The in-process OS substitute drains the model write.
        await new Promise<void>(resolve => setImmediate(resolve));
        finishInitialization();
        await disabling;
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
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');

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

    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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

    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');

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
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');

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

    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');

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

  it('reuses failed embeddings across idle work, Account publications and unchanged reloads but retries on explicit use', async () => {
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
      vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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

      const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
      const worker = await startMemoryWorker({
        credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
        machineId: 'machine_1',
        deps: { fetchDecryptedTranscriptPageAfterSeq: async () => [] },
      });
      try {
        await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(fetchSessionsPage).toHaveBeenCalled());
        publishInventory();
        await fetchSessionsPage.mock.results[0]!.value;
        await vi.advanceTimersByTimeAsync(2_500);
        expect(pipeline).toHaveBeenCalledTimes(1);
        expect(worker.getEmbeddingsDiagnostics()).toMatchObject({ runtimeState: 'error', usingFallback: true });

        setActiveAccountSettingsSnapshot({
          source: 'cache',
          settings: accountSettingsParse({}),
          settingsVersion: 1,
          loadedAtMs: Date.now(),
          settingsSecretsReadKeys: [],
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pipeline).toHaveBeenCalledTimes(1);
        expect(worker.getEmbeddingsDiagnostics()).toMatchObject({ runtimeState: 'error', usingFallback: true });

        await worker.ensureUpToDate('sess-1');
        await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(2));
        await vi.advanceTimersByTimeAsync(1_500);
        expect(pipeline).toHaveBeenCalledTimes(2);

        await worker.reloadSettings();
        expect(pipeline).toHaveBeenCalledTimes(2);
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
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');

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
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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

    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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

    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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

    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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
    await worker.ensureUpToDate('sess-policy');
    const rebuilt = await searchTier2Memory({
      dbPath: deepPath,
      query: { v: 1, query: 'admitted', scope: { type: 'global' }, mode: 'deep' },
      previewChars: 240,
    });
    expect(rebuilt.ok && rebuilt.hits.map((hit) => hit.type === undefined ? hit.sessionId : null)).toEqual(['sess-policy']);

    await worker.stop();
  });

  it('reuses retained tier1, deep and external rows on two unchanged non-default policy restarts', async () => {
    const session = { id: 'retained', machineId: 'machine_1', seq: 7, createdAt: 1000, updatedAt: 2000,
      active: false, activeAt: 0, archivedAt: null, encryptionMode: 'plain' };
    const fetchSession = vi.fn(async () => { throw new Error('source_temporarily_unavailable'); });
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionsPage: async ({ archivedOnly }: { archivedOnly?: boolean }) => ({ sessions: archivedOnly ? [] : [session], nextCursor: null, hasNext: false }),
      fetchSessionById: fetchSession,
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
      coveragePolicy: { type: 'full' }, contentPolicy: { includeAssistantMessages: false },
      conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const { memoryIndexPolicyKey, resolveMemoryIndexPolicy } = await import('./transcript/coveragePolicy');
    const { resolveExternalMemoryIndexPolicy } = await import('./externalTranscriptIndex');
    const { openProtectedSqliteDatabaseSync } = await import('../persistence/sqliteSync');
    const credentials: StoredCredentials = { token: 't', encryption: null };
    let worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });
    const tier1Path = worker.getTier1DbPath()!;
    const deepPath = worker.getDeepDbPath()!;
    const policyKey = memoryIndexPolicyKey(resolveMemoryIndexPolicy(worker.getSettings()));
    const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
    tier1.insertSummaryShard({ sessionId: 'retained', seqFrom: 1, seqTo: 7, createdAtFromMs: 1000,
      createdAtToMs: 1000, summary: 'quartz retained hint', keywords: [], entities: [], decisions: [], policyKey });
    tier1.trySeedSessionCursorsIfMissing({ sessionId: 'retained', nowMs: 1, lastHintedSeq: 7, lastDeepIndexedSeq: 7 });
    tier1.recordMemorySessionIndexState({ sessionId: 'retained', status: 'indexed', lastObservedSeq: 7,
      lastDeepIndexedSeq: 7, updatedAtMs: 1 });
    tier1.close();
    const source = { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'user', nativeSessionId: 'native' };
    const deep = openDeepIndexDb({ dbPath: deepPath });
    deep.insertChunk({ sessionId: 'retained', seqFrom: 1, seqTo: 7, createdAtFromMs: 1000, createdAtToMs: 1000, text: 'quartz retained deep', policyKey });
    deep.insertChunk({ sessionId: 'external', source, seqFrom: 1, seqTo: 1, createdAtFromMs: 1000, createdAtToMs: 1000, text: 'quartz native',
      policyKey: resolveExternalMemoryIndexPolicy(worker.getSettings()).key });
    deep.setExternalSourceState({ sessionId: 'external', source, cursor: 'retained-native-cursor', nextOrdinal: 1 });
    expect(deep.getDeepIndexStats().deepChunkCount).toBe(2);
    deep.close();
    try {
      for (let restart = 0; restart < 2; restart++) {
        await worker.stop();
        if (restart === 0) {
          // Simulate the current pre-fix index: it has row policy keys, but
          // does not yet record the policy of cursor-only projections.
          const older = openProtectedSqliteDatabaseSync(tier1Path);
          older.exec('DROP TABLE IF EXISTS memory_index_policy');
          older.close();
        }
        worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });
        const retainedTier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
        const retainedDeep = openDeepIndexDb({ dbPath: deepPath });
        try {
          expect(retainedTier1.getSummaryIndexStats().lightShardCount).toBe(1);
          expect(retainedTier1.getSessionCursors({ sessionId: 'retained', nowMs: 2 }).lastDeepIndexedSeq).toBe(7);
          expect.soft(worker.getIndexSources?.()).toContainEqual({
            source: { type: 'happier_session', sessionId: 'retained' }, state: 'ready',
          });
          expect.soft(retainedDeep.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true })
            .map(hit => hit.text).sort()).toEqual(['quartz native', 'quartz retained deep']);
          expect.soft(retainedDeep.getExternalSourceState({ sessionId: 'external' })?.cursor).toBe('retained-native-cursor');
        } finally { retainedTier1.close(); retainedDeep.close(); }
      }
      expect(fetchSession).not.toHaveBeenCalled();
      const changed = { ...worker.getSettings(), contentPolicy: { ...worker.getSettings().contentPolicy, includeAssistantMessages: true } };
      await worker.stop();
      await writeMemorySettingsToDisk(changed);
      worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });
      const changedIndex = openDeepIndexDb({ dbPath: deepPath });
      try { expect(changedIndex.getDeepIndexStats().deepChunkCount).toBe(0); } finally { changedIndex.close(); }
      expect(fetchSession).not.toHaveBeenCalled();
    } finally { await worker.stop(); }
  });

  it('keeps status/settings RPCs registered after a startup inventory failure and recovers on an access reset', async () => {
    vi.useFakeTimers();
    const session = { id: 'retained', machineId: 'machine_1', seq: 1, createdAt: 1000, updatedAt: 2000,
      active: false, activeAt: 0, archivedAt: null, encryptionMode: 'plain' };
    let unavailable = false;
    const fetchSessionsPage = vi.fn(async ({ archivedOnly }: { archivedOnly?: boolean }) => {
      if (unavailable) throw new Error('HTTP 500');
      return { sessions: archivedOnly ? [] : [session], nextCursor: null, hasNext: false };
    });
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture, fetchSessionsPage, fetchSessionById: async () => session }));
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: async () => ({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep' });
    const { configuration } = await import('@/configuration');
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
    const { registerMachineMemoryRpcHandlers } = await import('@/api/machine/rpcHandlers.memory');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const credentials: StoredCredentials = { token: 't', encryption: null };
    let worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });
    const db = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPath()! });
    db.trySeedSessionCursorsIfMissing({ sessionId: 'retained', nowMs: 1, lastHintedSeq: 1, lastDeepIndexedSeq: 1 });
    db.close();
    await worker.stop();
    unavailable = true;
    const daemonBefore = configuration.isDaemonProcess;
    setDaemonProcess(configuration, true);
    try {
      worker = await startMemoryWorker({ credentials, machineId: 'machine_1' });
      expect(worker.getWorkerStatus().state).toBe('error');
      expect(worker.getTier1DbPath()).toBeNull();
      const manager = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
      registerMachineMemoryRpcHandlers({ rpcHandlerManager: manager, memoryWorker: worker });
      expect(await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`, params: {} })).toMatchObject({ enabled: true });
      expect(await manager.handleRequest({ method: `machine_1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`, params: {} })).toMatchObject({ enabled: true, worker: { state: 'error' } });
      unavailable = false;
      await worker.reconcileRetainedSessionAccess();
      expect(worker.getTier1DbPath()).not.toBeNull();
      expect(worker.getWorkerStatus().state).not.toBe('error');
    } finally { await worker.stop(); setDaemonProcess(configuration, daemonBefore); vi.useRealTimers(); }
  });

  it('invalidates a real policy change before returning without waiting for source backfill', async () => {
    const fetchSessionById = vi.fn(async () => { throw new Error('HTTP 500'); });
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
      fetchSessionById,
      fetchSessionsPage: async () => ({ sessions: [], hasNext: false, nextCursor: null }),
    }));
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history' });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const worker = await startMemoryWorker({ credentials: { token: 't', encryption: null }, machineId: 'machine_1' });
    const path = worker.getDeepDbPath()!;
    const db = openDeepIndexDb({ dbPath: path });
    db.insertChunk({ sessionId: 'retained', seqFrom: 1, seqTo: 1, createdAtFromMs: 1000, createdAtToMs: 1000, text: 'old tool output' });
    db.close();
    const tier1 = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPath()! });
    tier1.trySeedSessionCursorsIfMissing({ sessionId: 'retained', nowMs: 1, lastHintedSeq: 1, lastDeepIndexedSeq: 1 });
    tier1.close();
    try {
      await writeMemorySettingsToDisk({ ...worker.getSettings(), deep: { ...worker.getSettings().deep, includeToolOutput: true } });
      await expect(worker.reloadSettings()).resolves.toBeUndefined();
      const read = openDeepIndexDb({ dbPath: path });
      try { expect(read.getDeepIndexStats().deepChunkCount).toBe(0); } finally { read.close(); }
      expect(fetchSessionById).not.toHaveBeenCalled();
    } finally { await worker.stop(); }
  });

  it('purges retained deep artifacts when deep policy changes while hints mode is active', async () => {
    const sessions = ['sess-stale-deep-policy', 'sess-deep-cursor-only'].map(id => ({
      id, machineId: 'machine_1', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 0, archivedAt: null,
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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

    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
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
    expect(transcriptText).toBe('latest topaz conversation');
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
      logger: { debug: loggerDebug, infoFile: vi.fn() },
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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

    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');

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
      const session = () => ({
        id: 'sess-1', machineId: 'machine_1', seq: observedSeq, createdAt: 1_000, updatedAt: 9_000,
        active: false, activeAt: 0, archivedAt: null, encryptionMode: 'plain',
      });
      const fetchSessionsPage = vi.fn(async ({ activeOnly }: { activeOnly?: boolean }) => ({
        sessions: activeOnly ? [] : [session()],
        nextCursor: null,
        hasNext: false,
      }));
      const fetchSessionById = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === 'sess-1' ? session() : null);
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

      vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionListPage: fetchMemorySessionListVisibilityFixture,
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

      const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
      const credentials: StoredCredentials = { token: 't', encryption: null };
      const worker = await startMemoryWorker({
        credentials,
        machineId: 'machine_1',
      });

      await worker.reloadSettings();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => {
        expect(fetchSessionsPage).toHaveBeenCalled();
        expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', activeOperations: [] });
      });

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

      // Idle activity/presence/ready changes carry the feed's Memory-unchanged proof: no Session read.
      const memoryReadsBeforeIdle = fetchSessionById.mock.calls.length;
      for (let tick = 0; tick < 5; tick += 1) await worker.noteSessionChanged!({ sessionId: 'sess-1', memoryInputsChanged: false });
      expect(fetchSessionById.mock.calls.length).toBe(memoryReadsBeforeIdle);

      const initialInventoryReads = fetchSessionsPage.mock.calls.length;
      await worker.noteSessionChanged!({ sessionId: 'sess-1' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(secondPageRequested).toBe(true));
      await vi.waitFor(() => expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', activeOperations: [] }));
      expect(fetchSessionsPage).toHaveBeenCalled();
      expect(fetchSessionsPage.mock.calls.length).toBe(initialInventoryReads);
      expect(fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', reason: 'memory-change' }));
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
