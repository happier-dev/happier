import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { syncMemoryHintsForSessionsOnce } from './syncMemoryHintsForSessionsOnce';

describe('syncMemoryHintsForSessionsOnce', () => {
  it.each(['onIdle', 'rate', 'backoff', 'modelFailure', 'commitFailure', 'recoveredFailure'] as const)(
    'reports the authoritative hint deferral deadline for %s', async (reason) => {
      const dir = await mkdtemp(join(os.tmpdir(), 'happier-hint-deferred-'));
      const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
      try {
        let nowMs = 10_000;
        let summarized = 0;
        let committed = 0;
        const deferred: number[] = [];
        const settings = { enabled: true, indexMode: 'hints' as const, backfillPolicy: 'all_history' as const,
          hints: { enabled: true, updateMode: reason === 'onIdle' ? 'onIdle' as const : 'continuous' as const,
            idleDelayMs: 5_000, windowSizeMessages: reason === 'recoveredFailure' ? 1 : 40, maxShardChars: 12_000, maxSummaryChars: 500,
            maxKeywords: 5, maxEntities: 5, maxDecisions: 5, maxRunsPerHour: reason === 'rate' || reason === 'recoveredFailure' ? 1 : 999,
            maxShardsPerSession: 250, failureBackoffBaseMs: 4_000, failureBackoffMaxMs: 16_000 } };
        if (reason === 'rate') tier1.tryAcquireHintRunPermit({ sessionId: 'session', nowMs: 8_000, maxRunsPerHour: 1 });
        if (reason === 'backoff') tier1.markHintRunFailure({ sessionId: 'session', nowMs: 9_000, backoffBaseMs: 4_000, backoffMaxMs: 16_000 });
        const sync = () => syncMemoryHintsForSessionsOnce({
          sessionIds: ['session'], tier1, settings, now: () => nowMs,
          onDeferred: atMs => deferred.push(atMs),
          fetchRecentDecryptedRows: async () => (reason === 'recoveredFailure' ? [1, 2] : [1]).map(seq => ({ seq, createdAtMs: 9_000, role: 'user' as const, content: { type: 'text', text: 'quasar handoff' } })),
          runSummarizer: async () => {
            summarized += 1;
            const seq = reason === 'recoveredFailure' ? 2 : 1;
            return reason === 'modelFailure' || (reason === 'recoveredFailure' && summarized === 1) ? 'invalid model output' : JSON.stringify({
              shard: { v: 1, seqFrom: seq, seqTo: seq, createdAtFromMs: 9_000, createdAtToMs: 9_000,
                summary: 'quasar handoff', keywords: [], entities: [], decisions: [] }, synopsis: null });
          },
          commitArtifacts: async () => {
            if (reason === 'commitFailure') throw new Error('Artifact transport failed');
            committed += 1;
          },
        });
        await sync();
        if (reason === 'recoveredFailure') {
          expect(committed).toBe(1);
          expect(summarized).toBe(2);
          expect(deferred).toEqual([]);
          return;
        }
        const deadline = reason === 'rate' ? 8_000 + 60 * 60 * 1_000 : reason === 'backoff' ? 13_000 : 14_000;
        expect(deferred).toEqual([deadline]);
        expect(committed).toBe(0);
        if (reason === 'onIdle' || reason === 'rate' || reason === 'backoff') {
          expect(summarized).toBe(0);
          nowMs = deadline - 1;
          await sync();
          expect(summarized).toBe(0);
          nowMs = deadline;
          await sync();
          expect(committed).toBe(1);
          expect(tier1.search({ query: 'quasar', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
          expect(deferred).toEqual([deadline, deadline]);
        }
      } finally { tier1.close(); await rm(dir, { recursive: true, force: true }); }
    },
  );

  it('stops the pass when the hint Run cannot run, and defers the Session', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-hint-run-refused-'));
    const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
    try {
      let attempts = 0;
      const deferred: number[] = [];
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['session'], tier1, now: () => 10_000, onDeferred: atMs => deferred.push(atMs),
        settings: { enabled: true, indexMode: 'hints' as const, backfillPolicy: 'all_history' as const,
          hints: { enabled: true, updateMode: 'continuous' as const, idleDelayMs: 0, windowSizeMessages: 1, maxShardChars: 12_000,
            maxSummaryChars: 500, maxKeywords: 5, maxEntities: 5, maxDecisions: 5, maxRunsPerHour: 999,
            maxShardsPerSession: 250, failureBackoffBaseMs: 4_000, failureBackoffMaxMs: 16_000 } },
        fetchRecentDecryptedRows: async () => [1, 2].map(seq => ({ seq, createdAtMs: 9_000, role: 'user' as const,
          content: { type: 'text' as const, text: `window ${seq}` } })),
        runSummarizer: async () => { attempts += 1; throw new Error('execution_run_target_unavailable'); },
        commitArtifacts: async () => { throw new Error('No Run produced an artifact'); },
      });
      expect(attempts).toBe(1);
      expect(deferred).toEqual([14_000]);
      expect(tier1.getSessionCursors({ sessionId: 'session', nowMs: 10_000 }).lastHintedSeq).toBe(0);
    } finally { tier1.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('backs off the Session and starts no Run when no Agent on the machine is ready for Auto', async () => {
    const { runMemoryHintsExecutionRun } = await import('./hints/runMemoryHintsExecutionRun');
    const { runLlmTaskTextPrompt } = await import('@/agent/executionRuns/tasks/textPromptWithRunnerConfig');
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-hint-run-unready-'));
    const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
    try {
      const executeStart = vi.fn(async () => ({ ok: true as const, result: {} }));
      const deferred: number[] = [];
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['session'], tier1, now: () => 10_000, onDeferred: atMs => deferred.push(atMs),
        settings: { enabled: true, indexMode: 'hints' as const, backfillPolicy: 'all_history' as const,
          hints: { enabled: true, updateMode: 'continuous' as const, idleDelayMs: 0, windowSizeMessages: 1, maxShardChars: 12_000,
            maxSummaryChars: 500, maxKeywords: 5, maxEntities: 5, maxDecisions: 5, maxRunsPerHour: 999,
            maxShardsPerSession: 250, failureBackoffBaseMs: 4_000, failureBackoffMaxMs: 16_000 } },
        fetchRecentDecryptedRows: async () => [{ seq: 1, createdAtMs: 9_000, role: 'user' as const, content: { type: 'text' as const, text: 'window' } }],
        runSummarizer: (prompt, sessionId, signal) => runMemoryHintsExecutionRun({ sessionId, prompt, choice: { v: 1, mode: 'auto' }, sessionAgentTargetKey: null, signal,
          runTextPrompt: (request => runLlmTaskTextPrompt({ ...request, executeStart,
            readCandidates: async () => ({ candidates: [], unavailableAgents: [{ agentTargetKey: 'agent:happier.agent.claude/claude', reason: 'sign_in_required' }] }) })) as typeof runLlmTaskTextPrompt }),
        commitArtifacts: async () => { throw new Error('No Run produced an artifact'); },
      });
      expect(executeStart).not.toHaveBeenCalled();
      expect(deferred).toEqual([14_000]);
    } finally { tier1.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('rebuilds edited same-sequence summaries and keeps empty projections empty across repeated ticks', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-edited-hints-'));
    const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
    try {
      tier1.init();
      const settings = { enabled: true, indexMode: 'hints' as const, backfillPolicy: 'all_history' as const,
        coveragePolicy: { type: 'full' as const }, hints: { enabled: true, updateMode: 'continuous' as const,
          idleDelayMs: 0, windowSizeMessages: 40, maxShardChars: 12_000, maxSummaryChars: 500,
          maxKeywords: 5, maxEntities: 5, maxDecisions: 5, maxRunsPerHour: 999,
          maxShardsPerSession: 250, failureBackoffBaseMs: 0, failureBackoffMaxMs: 0 } };
      let text = 'obsolete quartz';
      const sync = (forceSnapshotSessionIds?: readonly string[]) => syncMemoryHintsForSessionsOnce({
        sessionIds: ['edited'], forceSnapshotSessionIds, tier1, settings, now: () => 10_000,
        fetchRecentDecryptedRows: async () => {
          if (!settings.hints.enabled) throw new Error('Disabled hints must not read transcript content');
          return [{ seq: 1, createdAtMs: 1_000, role: 'user', content: { type: 'text', text } }];
        },
        runSummarizer: async () => {
          if (!settings.hints.enabled) throw new Error('Disabled hints must not run inference');
          return JSON.stringify({ shard: { v: 1, seqFrom: 1, seqTo: 1,
            createdAtFromMs: 1_000, createdAtToMs: 1_000, summary: text, keywords: [], entities: [], decisions: [] }, synopsis: null });
        },
        commitArtifacts: async () => {},
      });
      await sync();
      expect(tier1.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      text = 'replacement garnet';
      await sync(['edited']);
      expect(tier1.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(tier1.search({ query: 'garnet', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      await sync();
      expect(tier1.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      text = '';
      await sync(['edited']);
      await sync();
      await sync();
      expect(tier1.search({ query: 'garnet', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      tier1.deleteSessionIndexData({ sessionId: 'edited' });
      text = 'fresh cache topaz';
      await sync();
      expect(tier1.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(tier1.search({ query: 'topaz', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      settings.hints.enabled = false;
      text = 'current disabled-hints zirconium';
      await sync(['edited']);
      expect(tier1.search({ query: 'topaz', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(tier1.getSessionCursors({ sessionId: 'edited', nowMs: 10_000 }).lastHintedSeq).toBe(0);
      settings.hints.enabled = true;
      await sync();
      expect(tier1.search({ query: 'zirconium', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
    } finally { tier1.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('applies coverage after content policy so latest_messages counts semantic messages', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-sync-coverage-'));
    try {
      const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
      tier1.init();
      let promptText = '';
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          enabledAtMs: 0,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          coveragePolicy: { type: 'latest_messages', maxSemanticMessagesPerSession: 2 },
          contentPolicy: { includeUserMessages: true, includeAssistantMessages: false },
          hints: {
            enabled: true,
            updateMode: 'continuous', idleDelayMs: 0, windowSizeMessages: 40,
            maxShardChars: 12_000, maxSummaryChars: 500, maxKeywords: 5,
            maxEntities: 5, maxDecisions: 5, maxRunsPerHour: 999,
            maxShardsPerSession: 250, failureBackoffBaseMs: 0, failureBackoffMaxMs: 0,
          },
        },
        now: () => 10_000,
        fetchRecentDecryptedRows: async () => [
          { seq: 1, createdAtMs: 1_000, role: 'user' as const, content: { type: 'text', text: 'old user row' } },
          { seq: 2, createdAtMs: 2_000, role: 'agent' as const, content: { type: 'text', text: 'excluded assistant row' } },
          { seq: 3, createdAtMs: 3_000, role: 'user' as const, content: { type: 'text', text: 'middle user row' } },
          { seq: 4, createdAtMs: 4_000, role: 'user' as const, content: { type: 'text', text: 'latest user row' } },
        ],
        runSummarizer: async (prompt) => {
          promptText = prompt;
          return JSON.stringify({
            shard: { v: 1, seqFrom: 3, seqTo: 4, createdAtFromMs: 3_000, createdAtToMs: 4_000,
              summary: 'latest rows', keywords: [], entities: [], decisions: [] },
            synopsis: null,
          });
        },
        commitArtifacts: async () => {},
      });

      expect(promptText).not.toContain('old user row');
      expect(promptText).not.toContain('excluded assistant row');
      expect(promptText).toContain('middle user row');
      expect(promptText).toContain('latest user row');
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([true, false])('indexes semantic provider messages only with hints enabled (%s)', async (enabled) => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-sync-semantic-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows = [
        {
          seq: 1,
          createdAtMs: 1000,
          role: 'agent' as const,
          content: { type: 'codex', provider: 'codex', data: { type: 'message', message: 'Openclaw semantic provider memory row' } },
        },
      ];

      let promptText = '';
      let committed = 0;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          hints: {
            enabled,
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
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
        },
        now: () => 5000,
        fetchRecentDecryptedRows: async () => rows,
        runSummarizer: async (prompt) => {
          promptText = prompt;
          return JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 1,
              seqTo: 1,
              createdAtFromMs: 1000,
              createdAtToMs: 1000,
              summary: 'We discussed OpenClaw semantic provider memory.',
              keywords: [],
              entities: [],
              decisions: [],
            },
            synopsis: null,
          });
        },
        commitArtifacts: async () => {
          committed += 1;
        },
      });

      expect(committed).toBe(enabled ? 1 : 0);
      if (enabled) expect(promptText).toContain('Openclaw semantic provider memory row');
      else expect(promptText).toBe('');
      expect(tier1.search({ query: 'openclaw', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(enabled ? 1 : 0);

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('generates and indexes a new summary shard when a session has enough new messages', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-sync-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));

      let committed = 0;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          hints: {
            enabled: true,
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
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
        },
        now: () => 5000,
        fetchRecentDecryptedRows: async () => rows,
        runSummarizer: async () =>
          JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 1,
              seqTo: 40,
              createdAtFromMs: 1000,
              createdAtToMs: 1039,
              summary: 'We discussed OpenClaw memory search.',
              keywords: ['openclaw'],
              entities: [],
              decisions: [],
            },
            synopsis: null,
          }),
        commitArtifacts: async () => {
          committed += 1;
        },
      });

      expect(committed).toBe(1);

      const hits = tier1.search({ query: 'openclaw', scope: { type: 'global' }, maxResults: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0]!.sessionId).toBe('sess-1');

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not backfill old messages when backfillPolicy=new_only and the session is uninitialized', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-new-only-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));

      let summarizerCalls = 0;
      let committed = 0;

      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'new_only',
          hints: {
            enabled: true,
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
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
        },
        now: () => 5000,
        fetchRecentDecryptedRows: async () => rows as any,
        runSummarizer: async () => {
          summarizerCalls += 1;
          return '{}';
        },
        commitArtifacts: async () => {
          committed += 1;
        },
      });

      expect(summarizerCalls).toBe(0);
      expect(committed).toBe(0);

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('seeds uninitialized new_only sessions from the observed session seq without fetching old transcript rows', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-new-only-seed-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      let transcriptFetches = 0;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        initialCursorSeqBySessionId: new Map([['sess-1', 40]]),
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'new_only',
          hints: {
            enabled: true,
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
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
        },
        now: () => 5000,
        fetchRecentDecryptedRows: async () => {
          transcriptFetches += 1;
          return [];
        },
        runSummarizer: async () => '{}',
        commitArtifacts: async () => {},
      });

      expect(transcriptFetches).toBe(0);
      expect(tier1.getSessionCursors({ sessionId: 'sess-1', nowMs: 5000 }).lastHintedSeq).toBe(40);

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('indexes the first shard for a newly-created session when new_only explicitly allows initial backfill', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-new-only-allowed-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw memory search` },
      }));

      let committed = 0;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        allowInitialBackfillWhenUninitializedSessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'new_only',
          hints: {
            enabled: true,
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
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
        },
        now: () => 5000,
        fetchRecentDecryptedRows: async () => rows as any,
        runSummarizer: async () =>
          JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 1,
              seqTo: 40,
              createdAtFromMs: 1000,
              createdAtToMs: 1039,
              summary: 'We discussed OpenClaw memory search integration.',
              keywords: ['openclaw', 'memory'],
              entities: [],
              decisions: [],
            },
            synopsis: null,
          }),
        commitArtifacts: async () => {
          committed += 1;
        },
      });

      expect(committed).toBe(1);
      expect(tier1.search({ query: 'openclaw', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('respects maxRunsPerHour by throttling repeated hint runs for the same session', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-throttle-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows40 = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));
      const rows80 = Array.from({ length: 80 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 2000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));

      let rows: any[] = rows40;
      let summarizerCalls = 0;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          hints: {
            enabled: true,
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            maxKeywords: 5,
            maxEntities: 5,
            maxDecisions: 5,
            maxRunsPerHour: 1,
            maxShardsPerSession: 250,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        now: () => 10_000,
        fetchRecentDecryptedRows: async () => rows as any,
        runSummarizer: async () => {
          summarizerCalls += 1;
          return JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 1,
              seqTo: rows.length,
              createdAtFromMs: 1000,
              createdAtToMs: 1000 + rows.length - 1,
              summary: 'first',
              keywords: ['first'],
              entities: [],
              decisions: [],
            },
            synopsis: null,
          });
        },
        commitArtifacts: async () => {},
      });

      rows = rows80;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          hints: {
            enabled: true,
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            maxKeywords: 5,
            maxEntities: 5,
            maxDecisions: 5,
            maxRunsPerHour: 1,
            maxShardsPerSession: 250,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        now: () => 10_100,
        fetchRecentDecryptedRows: async () => rows as any,
        runSummarizer: async () => {
          summarizerCalls += 1;
          return JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 1,
              seqTo: rows.length,
              createdAtFromMs: 1000,
              createdAtToMs: 1000 + rows.length - 1,
              summary: 'second',
              keywords: ['second'],
              entities: [],
              decisions: [],
            },
            synopsis: null,
          });
        },
        commitArtifacts: async () => {},
      });

      expect(summarizerCalls).toBe(1);
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evicts older hint shards when maxShardsPerSession is exceeded', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-evict-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows40 = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));
      const rows80 = Array.from({ length: 80 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 2000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));

      let rows: any[] = rows40;
      let call = 0;
      const runOnce = async () => {
        await syncMemoryHintsForSessionsOnce({
          sessionIds: ['sess-1'],
          tier1,
          settings: {
            enabled: true,
            indexMode: 'hints',
            backfillPolicy: 'all_history',
          hints: {
            enabled: true,
            updateMode: 'continuous',
              idleDelayMs: 0,
              windowSizeMessages: 40,
              maxShardChars: 12_000,
              maxSummaryChars: 500,
              maxKeywords: 5,
              maxEntities: 5,
              maxDecisions: 5,
              maxRunsPerHour: 999,
              maxShardsPerSession: 1,
              failureBackoffBaseMs: 0,
              failureBackoffMaxMs: 0,
            },
          },
          now: () => 50_000 + call,
          fetchRecentDecryptedRows: async () => rows as any,
          runSummarizer: async () => {
            call += 1;
            return JSON.stringify({
              shard: {
                v: 1,
                seqFrom: 1,
                seqTo: rows.length,
                createdAtFromMs: 1000,
                createdAtToMs: 1000 + rows.length - 1,
                summary: call === 1 ? 'first term' : 'second term',
                keywords: [call === 1 ? 'firstterm' : 'secondterm'],
                entities: [],
                decisions: [],
              },
              synopsis: null,
            });
          },
          commitArtifacts: async () => {},
        });
      };

      await runOnce();
      rows = rows80;
      await runOnce();

      expect(tier1.search({ query: 'firstterm', scope: { type: 'session', sessionId: 'sess-1' }, maxResults: 10 })).toEqual([]);
      expect(tier1.search({ query: 'secondterm', scope: { type: 'session', sessionId: 'sess-1' }, maxResults: 10 }).length).toBe(1);

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
