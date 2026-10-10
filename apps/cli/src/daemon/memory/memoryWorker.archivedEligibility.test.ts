import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { Credentials } from '@/persistence';

type SessionsPageArgs = Readonly<{ activeOnly?: boolean; archivedOnly?: boolean; cursor?: string; limit?: number }>;

const CREDENTIALS: Credentials = {
  token: 't',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

function sessionRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, machineId: 'machine_1', seq: 1, createdAt: 1_000, updatedAt: 9_000, activeAt: 0, ...extra };
}

describe('memoryWorker archived eligibility and derived-index removal', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let homeDir: string | undefined;
  let argvBackup: string[] = [];
  const startedWorkers = new Set<Readonly<{ stop: () => void | Promise<void> }>>();

  beforeEach(async () => {
    homeDir = await createTempDir('happier-memory-archived-');
    applyEnvValues({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: 'https://api.example.test',
      HAPPIER_WEBAPP_URL: 'https://app.example.test',
    });
    argvBackup = process.argv.slice();
    process.argv = ['node', 'happier', 'daemon', 'start-sync'];
    vi.resetModules();
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'e2ee', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error(`Unexpected memory test HTTP path: ${String(url)}`);
    });
    vi.doMock('./transcript/fetchSemanticPage', () => ({
      fetchMemorySemanticTranscriptPage: vi.fn(async () => ({
        items: [],
        hasMore: false,
        nextCursor: null,
      })),
    }));
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
    process.argv = argvBackup;
    restoreEnvValues(envBackup);
    vi.doUnmock('@/configuration');
    vi.doUnmock('@/session/transport/http/sessionsHttp');
    vi.doUnmock('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.doUnmock('@/session/systemRecords/memory/fetchMemorySystemRecords');
    vi.doUnmock('./removeMemorySessionIndexes');
    vi.doUnmock('./transcript/fetchSemanticPage');
    vi.resetModules();
    vi.useRealTimers();
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

  function mockDaemonProcess(): void {
    vi.doMock('@/configuration', async () => {
      const actual = await vi.importActual<typeof import('@/configuration')>('@/configuration');
      return {
        ...actual,
        configuration: { ...actual.configuration, isDaemonProcess: true },
      };
    });
  }

  function mockSessionsHttp(handler: (args: SessionsPageArgs) => {
    sessions: Array<Record<string, unknown>>;
    nextCursor: string | null;
    hasNext: boolean;
  }) {
    const calls: SessionsPageArgs[] = [];
    const fetchSessionsPage = vi.fn(async (args: SessionsPageArgs) => {
      calls.push(args);
      return handler(args);
    });
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage,
      fetchSessionById: vi.fn(async () => ({})),
    }));
    return { calls, fetchSessionsPage };
  }

  async function startWorker(
    settings: Record<string, unknown>,
    deps: Readonly<{
      fetchDecryptedTranscriptPageAfterSeq?: (args: Readonly<{
        sessionId: string;
        afterSeq: number;
        limit: number;
        signal?: AbortSignal;
      }>) => Promise<Array<{
        seq: number;
        createdAtMs: number;
        role: 'user' | 'agent';
        content: { type: 'text'; text: string };
        meta?: null;
      }>>;
    }> = {},
  ) {
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      worker: {
        tickIntervalMs: 500,
        inventoryRefreshIntervalMs: 5_000,
        maxSessionsPerTick: 1,
        sessionListPageLimit: 10,
      },
      ...settings,
    });
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({
      credentials: CREDENTIALS,
      machineId: 'machine_1',
      deps: {
        fetchDecryptedTranscriptPageAfterSeq:
          deps.fetchDecryptedTranscriptPageAfterSeq ?? (async () => []),
      },
    });
    startedWorkers.add(worker);
    return worker;
  }

  async function seedIndexedSession(tier1DbPath: string, sessionId: string): Promise<void> {
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const db = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    db.insertSummaryShard({
      sessionId,
      seqFrom: 1,
      seqTo: 2,
      createdAtFromMs: 1,
      createdAtToMs: 2,
      summary: 'transcript about migrations',
      keywords: ['migrations'],
      entities: [],
      decisions: [],
    });
    db.close();
  }

  async function listIndexedSessionIds(tier1DbPath: string): Promise<string[]> {
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const db = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    try {
      return [...db.listIndexedSessionIds()];
    } finally {
      db.close();
    }
  }

  async function searchIndexedSessionIds(tier1DbPath: string): Promise<string[]> {
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const db = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    try {
      return db.search({ query: 'migrations', scope: { type: 'global' }, maxResults: 10 })
        .map((hit) => hit.sessionId);
    } finally {
      db.close();
    }
  }

  it('never requests the archived inventory under new_only while archived eligibility is off', async () => {
    vi.useFakeTimers();
    mockDaemonProcess();
    const { calls } = mockSessionsHttp(() => ({ sessions: [sessionRow('s1')], nextCursor: null, hasNext: false }));

    const worker = await startWorker({ backfillPolicy: 'new_only' });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.archivedOnly === true)).toBe(false);
    await vi.waitFor(() => {
      expect(worker.getWorkerStatus()).toMatchObject({ state: 'idle', currentPhase: null });
    });
    worker.stop();
  });

  it('reports a background indexing failure instead of remaining indexing', async () => {
    vi.useFakeTimers();
    mockDaemonProcess();
    mockSessionsHttp(() => ({ sessions: [sessionRow('failing-index')], nextCursor: null, hasNext: false }));
    vi.doMock('./transcript/fetchSemanticPage', () => ({
      fetchMemorySemanticTranscriptPage: vi.fn(async () => {
        throw new Error('background_index_failed');
      }),
    }));

    const worker = await startWorker({ backfillPolicy: 'all_history' });
    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(worker.getWorkerStatus()).toMatchObject({ state: 'error', currentPhase: null });
    });
  });

  it('enforces disk budgets even when inventory has no indexing candidates', async () => {
    vi.useFakeTimers();
    mockDaemonProcess();
    mockSessionsHttp(() => ({ sessions: [], nextCursor: null, hasNext: false }));
    const worker = await startWorker({});
    const tier1DbPath = worker.getTier1DbPath()!;
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const budgetSeed = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    budgetSeed.insertSummaryShard({
      sessionId: 'budget-only',
      seqFrom: 1,
      seqTo: 1,
      createdAtFromMs: 1,
      createdAtToMs: 1,
      summary: 'x'.repeat(2 * 1024 * 1024),
      keywords: [],
      entities: [],
      decisions: [],
    });
    budgetSeed.checkpointAndVacuum();
    budgetSeed.close();
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({
      v: 1,
      enabled: true,
      indexMode: 'hints',
      budgets: { maxDiskMbLight: 1, maxDiskMbDeep: 1 },
    });
    await worker.reloadSettings();

    await vi.advanceTimersByTimeAsync(1_000);
    const stopPromise = worker.stop();
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(await listIndexedSessionIds(tier1DbPath)).toEqual([]);
  });

  it('never requests the archived inventory under all_history while archived eligibility is off', async () => {
    vi.useFakeTimers();
    mockDaemonProcess();
    const { calls } = mockSessionsHttp(() => ({ sessions: [sessionRow('s1')], nextCursor: null, hasNext: false }));

    const worker = await startWorker({ backfillPolicy: 'all_history' });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.archivedOnly === true)).toBe(false);
    worker.stop();
  });

  it('pages the archived inventory under new_only when archived eligibility is on', async () => {
    vi.useFakeTimers();
    mockDaemonProcess();
    const { calls } = mockSessionsHttp((args) => ({
      sessions: args.archivedOnly ? [sessionRow('archived_1')] : [sessionRow('s1')],
      nextCursor: null,
      hasNext: false,
    }));

    const worker = await startWorker({ backfillPolicy: 'new_only', includeArchivedSessions: true });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(calls.some((call) => call.archivedOnly === true)).toBe(true);
    worker.stop();
  });

  it('pages the archived inventory under all_history when archived eligibility is on', async () => {
    vi.useFakeTimers();
    mockDaemonProcess();
    const { calls } = mockSessionsHttp((args) => ({
      sessions: args.archivedOnly ? [sessionRow('archived_1')] : [sessionRow('s1')],
      nextCursor: null,
      hasNext: false,
    }));

    const worker = await startWorker({ backfillPolicy: 'all_history', includeArchivedSessions: true });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(calls.some((call) => call.archivedOnly === true)).toBe(true);
    worker.stop();
  });

  it('reports the archived eligibility this daemon actually applies', async () => {
    mockSessionsHttp(() => ({ sessions: [], nextCursor: null, hasNext: false }));
    const worker = await startWorker({ includeArchivedSessions: true });
    expect(worker.getSettings().includeArchivedSessions).toBe(true);
    worker.stop();
  });

  it('purges derived index rows and worker state for a removed session', async () => {
    mockSessionsHttp(() => ({ sessions: [], nextCursor: null, hasNext: false }));
    const worker = await startWorker({});
    const tier1DbPath = worker.getTier1DbPath()!;
    await seedIndexedSession(tier1DbPath, 'removal_gone');
    await seedIndexedSession(tier1DbPath, 'removal_kept');
    expect(await searchIndexedSessionIds(tier1DbPath)).toContain('removal_gone');

    await worker.removeSessions(['removal_gone']);

    const after = await searchIndexedSessionIds(tier1DbPath);
    expect(after).not.toContain('removal_gone');
    expect(after).toContain('removal_kept');
    worker.stop();
  });

  it('purges a session that becomes archived while archived eligibility is off', async () => {
    mockSessionsHttp(() => ({ sessions: [], nextCursor: null, hasNext: false }));
    const worker = await startWorker({ includeArchivedSessions: false });
    const tier1DbPath = worker.getTier1DbPath()!;
    await seedIndexedSession(tier1DbPath, 'archived_off');
    expect(await searchIndexedSessionIds(tier1DbPath)).toContain('archived_off');

    await worker.applySessionArchivedState({ sessionId: 'archived_off', archived: true });

    expect(await searchIndexedSessionIds(tier1DbPath)).not.toContain('archived_off');
    worker.stop();
  });

  it('keeps archive exclusion pending and rethrows when a live archive purge fails', async () => {
    mockSessionsHttp(() => ({ sessions: [], nextCursor: null, hasNext: false }));
    const purgeError = new Error('archive_purge_failed');
    vi.doMock('./removeMemorySessionIndexes', () => ({
      removeMemorySessionIndexes: vi.fn(() => {
        throw purgeError;
      }),
    }));
    const worker = await startWorker({ includeArchivedSessions: false });

    await expect(worker.applySessionArchivedState({
      sessionId: 'archive-purge-failure',
      archived: true,
    })).rejects.toBe(purgeError);

    expect(worker.getSettings().includeArchivedSessions).toBe(true);
  });

  it('retains a session that becomes archived while archived eligibility is on', async () => {
    mockSessionsHttp(() => ({ sessions: [], nextCursor: null, hasNext: false }));
    const worker = await startWorker({ includeArchivedSessions: true });
    const tier1DbPath = worker.getTier1DbPath()!;
    await seedIndexedSession(tier1DbPath, 'archived_on');

    await worker.applySessionArchivedState({ sessionId: 'archived_on', archived: true });

    expect(await searchIndexedSessionIds(tier1DbPath)).toContain('archived_on');
    worker.stop();
  });

  it('reconciles missed archive events for indexed sessions when archived eligibility is off', async () => {
    mockSessionsHttp((args) => ({
      sessions: args.archivedOnly ? [sessionRow('stale_archived')] : [],
      nextCursor: null,
      hasNext: false,
    }));
    const worker = await startWorker({});
    const tier1DbPath = worker.getTier1DbPath()!;
    await seedIndexedSession(tier1DbPath, 'stale_archived');
    await seedIndexedSession(tier1DbPath, 'still_active');
    expect(await searchIndexedSessionIds(tier1DbPath)).toContain('stale_archived');

    await worker.reloadSettings();

    const after = await searchIndexedSessionIds(tier1DbPath);
    expect(after).not.toContain('stale_archived');
    expect(after).toContain('still_active');
    worker.stop();
  });

  it('reconciles the whole retained indexed set, including archived pages far past the listing head', async () => {
    // One Session per page, with the stale archived row deep in the listing:
    // the retained indexed set is what must be covered, not a fixed number of
    // server pages.
    const archivedIds = Array.from({ length: 40 }, (_, index) => `arch_${index + 1}`);
    mockSessionsHttp((args) => {
      if (!args.archivedOnly) return { sessions: [], nextCursor: null, hasNext: false };
      const index = args.cursor ? Number(args.cursor) : 0;
      const id = archivedIds[index];
      const next = index + 1;
      return {
        sessions: id ? [sessionRow(id)] : [],
        nextCursor: next < archivedIds.length ? String(next) : null,
        hasNext: next < archivedIds.length,
      };
    });
    const worker = await startWorker({
      worker: {
        tickIntervalMs: 500,
        inventoryRefreshIntervalMs: 5_000,
        maxSessionsPerTick: 1,
        sessionListPageLimit: 1,
      },
    });
    const tier1DbPath = worker.getTier1DbPath()!;
    await seedIndexedSession(tier1DbPath, 'arch_31');
    await seedIndexedSession(tier1DbPath, 'still_active');

    await worker.reloadSettings();

    const after = await searchIndexedSessionIds(tier1DbPath);
    expect(after).not.toContain('arch_31');
    expect(after).toContain('still_active');
    expect(worker.getSettings().includeArchivedSessions).toBe(false);
    worker.stop();
  });

  it('keeps reporting archived-inclusive eligibility until the exclusion reconciliation succeeds', async () => {
    vi.useFakeTimers();
    mockDaemonProcess();
    let archivedListingFails = true;
    mockSessionsHttp((args) => {
      if (!args.archivedOnly) return { sessions: [], nextCursor: null, hasNext: false };
      if (archivedListingFails) throw new Error('transient_archived_listing_failure');
      return { sessions: [sessionRow('stale_archived')], nextCursor: null, hasNext: false };
    });
    const worker = await startWorker({});
    const tier1DbPath = worker.getTier1DbPath()!;
    await seedIndexedSession(tier1DbPath, 'stale_archived');

    await worker.reloadSettings();

    // The archived rows are still searchable, so the daemon must not advertise
    // that it applies the exclusion yet.
    expect(worker.getSettings().includeArchivedSessions).toBe(true);
    expect(await searchIndexedSessionIds(tier1DbPath)).toContain('stale_archived');

    archivedListingFails = false;
    await vi.advanceTimersByTimeAsync(6_000);

    expect(worker.getSettings().includeArchivedSessions).toBe(false);
    expect(await searchIndexedSessionIds(tier1DbPath)).not.toContain('stale_archived');
    worker.stop();
  });

  it('forgets the cached Session crypto context of a removed session', async () => {
    const fetchSessionById = vi.fn(async () => ({
      id: 'crypto_session',
      machineId: 'machine_1',
      seq: 0,
      createdAt: Number.MAX_SAFE_INTEGER,
      archivedAt: null,
    }));
    const fetchSessionsPage = vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionsPage, fetchSessionById }));
    vi.doMock('@/session/systemRecords/memory/fetchMemorySystemRecords', () => ({
      fetchMemorySummaryShardSystemRecords: vi.fn(async () => []),
    }));
    vi.doMock('./transcript/fetchSemanticPage', () => ({
      fetchMemorySemanticTranscriptPage: vi.fn(async () => ({
        items: [],
        hasMore: false,
        nextCursor: null,
      })),
    }));

    const worker = await startWorker({});
    await worker.ensureUpToDate('crypto_session');
    await worker.ensureUpToDate('crypto_session');
    // Each explicit daemon refresh reads current Session metadata for the
    // new-only eligibility decision. The crypto context itself is cached, so
    // the first refresh performs one additional read and the second does not.
    expect(fetchSessionById).toHaveBeenCalledTimes(3);

    await worker.removeSessions(['crypto_session']);
    await worker.ensureUpToDate('crypto_session');

    // Removal invalidates only the crypto-context read; the next explicit
    // refresh therefore performs its ordinary eligibility read plus one new
    // context read.
    expect(fetchSessionById).toHaveBeenCalledTimes(5);
    worker.stop();
  });

  it('lists the Session identities the derived index still retains', async () => {
    mockSessionsHttp(() => ({ sessions: [], nextCursor: null, hasNext: false }));
    const worker = await startWorker({});
    const tier1DbPath = worker.getTier1DbPath()!;
    await worker.removeSessions(worker.listIndexedSessionIds());
    await seedIndexedSession(tier1DbPath, 'retained_1');
    await seedIndexedSession(tier1DbPath, 'retained_2');

    expect([...worker.listIndexedSessionIds()].sort()).toEqual(['retained_1', 'retained_2']);

    await worker.removeSessions(['retained_1']);
    expect([...worker.listIndexedSessionIds()]).toEqual(['retained_2']);
    worker.stop();
  });

  it('uses paged visible-session inventory for retained access reconciliation', async () => {
    const fetchSessionById = vi.fn();
    const fetchSessionsPage = vi.fn(async ({ archivedOnly, cursor }: SessionsPageArgs) => {
      if (archivedOnly) {
        return cursor
          ? { sessions: [sessionRow('deep-archived', { archivedAt: 2 })], nextCursor: null, hasNext: false }
          : { sessions: [], nextCursor: 'archived-2', hasNext: true };
      }
      return cursor
        ? { sessions: [sessionRow('deep-kept', { archivedAt: null })], nextCursor: null, hasNext: false }
        : { sessions: [], nextCursor: 'active-2', hasNext: true };
    });
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage,
      fetchSessionById,
    }));
    const worker = await startWorker({ indexMode: 'deep', includeArchivedSessions: true });
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const deepDb = openDeepIndexDb({ dbPath: worker.getDeepDbPath()! });
    for (const sessionId of ['deep-kept', 'deep-archived', 'deep-revoked']) {
      deepDb.insertChunk({
        sessionId,
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        text: `retained ${sessionId}`,
      });
    }
    deepDb.close();

    expect([...worker.listIndexedSessionIds()].sort()).toEqual(['deep-archived', 'deep-kept', 'deep-revoked']);
    await worker.reconcileRetainedSessionAccess();
    expect([...worker.listIndexedSessionIds()].sort()).toEqual(['deep-archived', 'deep-kept']);
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(fetchSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'active-2' }));
    expect(fetchSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'archived-2' }));
    worker.stop();
  });

  it('removes archived retained Sessions during access reconciliation when archive indexing is disabled', async () => {
    const { fetchSessionsPage } = mockSessionsHttp(({ archivedOnly }) => ({
      sessions: archivedOnly ? [sessionRow('missed-archive', { archivedAt: 9_000 })] : [],
      nextCursor: null,
      hasNext: false,
    }));
    const worker = await startWorker({ indexMode: 'deep', includeArchivedSessions: false });
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const deepDb = openDeepIndexDb({ dbPath: worker.getDeepDbPath()! });
    deepDb.insertChunk({
      sessionId: 'missed-archive',
      seqFrom: 1,
      seqTo: 1,
      createdAtFromMs: 1,
      createdAtToMs: 1,
      text: 'stale archived transcript',
    });
    deepDb.close();

    await worker.reconcileRetainedSessionAccess();

    expect(worker.listIndexedSessionIds()).not.toContain('missed-archive');
    expect(fetchSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ activeOnly: false }));
    worker.stop();
  });

  it('aborts and waits for in-flight indexing before purging a removed Session', async () => {
    const transcriptStarted = createDeferred();
    let transcriptSignal: AbortSignal | undefined;
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false })),
      fetchSessionById: vi.fn(async () => sessionRow('removed-in-flight', { archivedAt: null })),
    }));
    const worker = await startWorker(
      { indexMode: 'deep', backfillPolicy: 'all_history' },
      {
        fetchDecryptedTranscriptPageAfterSeq: async ({ signal }) => {
          transcriptSignal = signal;
          transcriptStarted.resolve();
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return [];
        },
      },
    );

    const indexing = worker.ensureUpToDate('removed-in-flight');
    await transcriptStarted.promise;
    const removal = worker.removeSessions(['removed-in-flight']);
    const [indexingResult, removalResult] = await Promise.allSettled([indexing, removal]);

    expect(transcriptSignal?.aborted).toBe(true);
    expect(indexingResult.status).toBe('fulfilled');
    expect(removalResult.status).toBe('fulfilled');
    expect(worker.listIndexedSessionIds()).not.toContain('removed-in-flight');
    await worker.stop();
  });

  it('passes the loop lifecycle signal into active transcript work before shutdown settles', async () => {
    mockDaemonProcess();
    const transcriptStarted = createDeferred();
    let transcriptSignal: AbortSignal | undefined;
    mockSessionsHttp(() => ({
      sessions: [sessionRow('shutdown-in-flight', { archivedAt: null })],
      nextCursor: null,
      hasNext: false,
    }));
    const worker = await startWorker(
      { indexMode: 'deep', backfillPolicy: 'all_history' },
      {
        fetchDecryptedTranscriptPageAfterSeq: async ({ signal }) => {
          transcriptSignal = signal;
          transcriptStarted.resolve();
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return [];
        },
      },
    );

    await transcriptStarted.promise;
    await worker.stop();

    expect(transcriptSignal?.aborted).toBe(true);
  });

  it('does not let explicit ensureUpToDate bypass archived opt-in', async () => {
    const fetchTranscript = vi.fn(async () => [{
      seq: 1,
      createdAtMs: 1,
      role: 'user' as const,
      content: { type: 'text' as const, text: 'archived explicit history' },
      meta: null,
    }]);
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false })),
      fetchSessionById: vi.fn(async () => sessionRow('archived-explicit', { archivedAt: 9_000 })),
    }));
    const worker = await startWorker(
      { indexMode: 'deep', includeArchivedSessions: false },
      { fetchDecryptedTranscriptPageAfterSeq: fetchTranscript },
    );

    await worker.ensureUpToDate('archived-explicit');

    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(worker.listIndexedSessionIds()).not.toContain('archived-explicit');
    worker.stop();
  });

  it('seeds new_only progress before deep work for pre-enablement Sessions', async () => {
    vi.doUnmock('./transcript/fetchSemanticPage');
    const rows = [
      {
        seq: 1,
        createdAtMs: 1,
        role: 'user' as const,
        content: { type: 'text' as const, text: 'old history must stay excluded' },
        meta: null,
      },
    ];
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: vi.fn(async () => ({ messages: rows.map(row => ({
        id: String(row.seq), seq: row.seq, createdAt: row.createdAtMs, messageRole: row.role,
        content: { t: 'plain', v: { role: row.role, content: row.content } },
      })), hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })),
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false })),
      fetchSessionById: vi.fn(async () => sessionRow('old-explicit', {
        seq: 1,
        createdAt: 1,
        archivedAt: null,
        encryptionMode: 'plain',
      })),
    }));
    const worker = await startWorker(
      { indexMode: 'deep', backfillPolicy: 'new_only', enabledAtMs: 5_000 },
    );

    await worker.ensureUpToDate('old-explicit');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const progress = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPath()! });
    expect(progress.getSessionCursors({ sessionId: 'old-explicit', nowMs: Date.now() }).lastDeepIndexedSeq).toBe(1);
    progress.close();

    rows.push({
      seq: 2,
      createdAtMs: 6_000,
      role: 'user',
      content: { type: 'text', text: 'new follow-up remains discoverable' },
      meta: null,
    });
    await worker.ensureUpToDate('old-explicit');

    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const db = openDeepIndexDb({ dbPath: worker.getDeepDbPath()! });
    expect(db.search({ query: 'history', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
    expect(db.search({ query: 'follow-up', scope: { type: 'global' }, maxResults: 10 })
      .map((hit) => hit.sessionId)).toEqual(['old-explicit']);
    db.close();
    worker.stop();
  });

  it('preserves new_only allowInitialBackfill semantics in bulk ensureUpToDate', async () => {
    vi.doUnmock('./transcript/fetchSemanticPage');
    vi.doMock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
      fetchEncryptedTranscriptMessagesPage: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ messages: [{
        id: sessionId, seq: sessionId === 'old-bulk' ? 8 : 2, createdAt: sessionId === 'old-bulk' ? 1 : 6_000,
        messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text',
          text: sessionId === 'old-bulk' ? 'excluded obsolete bulk history' : 'admitted garnet bulk history' } } },
      }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null })),
    }));
    vi.doMock('@/session/transport/http/sessionsHttp', () => ({
      fetchSessionsPage: vi.fn(async ({ archivedOnly }: SessionsPageArgs) => ({
        sessions: archivedOnly
          ? []
          : [
              sessionRow('old-bulk', { seq: 8, createdAt: 1, archivedAt: null }),
              sessionRow('new-bulk', { seq: 2, createdAt: 6_000, archivedAt: null }),
            ],
        nextCursor: null,
        hasNext: false,
      })),
      fetchSessionById: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        id: sessionId,
        machineId: 'machine_1',
        archivedAt: null,
        encryptionMode: 'plain',
      })),
    }));
    const worker = await startWorker(
      { indexMode: 'deep', backfillPolicy: 'new_only', enabledAtMs: 5_000 },
    );

    await worker.ensureUpToDate();

    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const db = openDeepIndexDb({ dbPath: worker.getDeepDbPath()! });
    expect(db.search({ query: 'obsolete', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
    expect(db.search({ query: 'garnet', scope: { type: 'global' }, maxResults: 10 }).map(hit => hit.sessionId)).toEqual(['new-bulk']);
    db.close();
    worker.stop();
  });

  it('does not request the archived inventory for reconciliation when nothing is indexed', async () => {
    const { calls } = mockSessionsHttp(() => ({ sessions: [], nextCursor: null, hasNext: false }));
    const worker = await startWorker({});
    await worker.removeSessions(await listIndexedSessionIds(worker.getTier1DbPath()!));
    const before = calls.length;

    await worker.reloadSettings();

    expect(calls.slice(before).some((call) => call.archivedOnly === true)).toBe(false);
    worker.stop();
  });
});
