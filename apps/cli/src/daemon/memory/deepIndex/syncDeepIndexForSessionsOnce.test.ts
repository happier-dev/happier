import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSummaryShardIndexDb } from '../summaryShardIndexDb';
import { openDeepIndexDb } from './deepIndexDb';
import { syncDeepIndexForSessionsOnce } from './syncDeepIndexForSessionsOnce';
import { memoryIndexPolicyKey, resolveMemoryIndexPolicy } from '../transcript/coveragePolicy';

describe('syncDeepIndexForSessionsOnce', () => {
  it('replaces indexed text when a snapshot contains an edit at the same sequence', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-edit-'));
    const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
    const deep = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    try {
      tier1.init();
      deep.init();
      deep.insertChunk({ sessionId: 'edited', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2, text: 'obsolete quartz content',
        policyKey: memoryIndexPolicyKey(resolveMemoryIndexPolicy({ coveragePolicy: { type: 'full' } })) });
      tier1.markDeepIndexSuccess({ sessionId: 'edited', seqTo: 2, nowMs: 1 });
      await syncDeepIndexForSessionsOnce({
        sessionIds: ['edited'], tier1, deep, now: () => 10_000,
        settings: { enabled: true, indexMode: 'deep', forceSnapshot: true, coveragePolicy: { type: 'full' },
          deep: { maxChunkChars: 8000, maxChunkMessages: 20, minChunkMessages: 1,
            includeAssistantAcpMessage: true, failureBackoffBaseMs: 0, failureBackoffMaxMs: 0 } },
        fetchDecryptedTranscriptPageAfterSeq: async () => [],
        fetchRecentDecryptedRows: async () => [{ seq: 2, createdAtMs: 2, role: 'user', content: { type: 'text', text: 'replacement garnet content' } }],
      });
      expect(deep.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(deep.search({ query: 'garnet', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
    } finally { deep.close(); tier1.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('applies since_enabled coverage to deep semantic rows', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-coverage-'));
    try {
      const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
      deep.init();
      await syncDeepIndexForSessionsOnce({
        sessionIds: ['sess-1'], tier1, deep, now: () => 10_000,
        settings: {
          enabled: true, enabledAtMs: 2_000, indexMode: 'deep',
          coveragePolicy: { type: 'since_enabled' },
          deep: { maxChunkChars: 8_000, maxChunkMessages: 20, minChunkMessages: 1,
            includeAssistantAcpMessage: true, failureBackoffBaseMs: 0, failureBackoffMaxMs: 0 },
        },
        fetchDecryptedTranscriptPageAfterSeq: async () => [
          { seq: 1, createdAtMs: 1_999, role: 'user' as const, content: { type: 'text', text: 'before enable secret' } },
          { seq: 2, createdAtMs: 2_000, role: 'user' as const, content: { type: 'text', text: 'at enable visible' } },
        ],
      });
      expect(deep.search({ query: 'secret', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(deep.search({ query: 'visible', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips ACP and Codex assistant payload content when includeAssistantAcpMessage is false', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-assistant-acp-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      await syncDeepIndexForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          contentPolicy: {
            includeUserMessages: true,
            includeAssistantMessages: true,
            includeReasoning: true,
            includeToolSummaries: false,
            includeToolOutputs: false,
          },
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: false,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async () => [
          { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'visible user prompt' }, meta: null },
          {
            seq: 2,
            createdAtMs: 1001,
            role: 'agent' as const,
            content: { type: 'acp', agentId: 'acp', data: { type: 'message', message: 'hidden acp assistant text' } },
            meta: null,
          },
          {
            seq: 3,
            createdAtMs: 1002,
            role: 'agent' as const,
            content: { type: 'acp', agentId: 'acp', data: { type: 'reasoning', message: 'hidden acp reasoning trace' } },
            meta: null,
          },
          {
            seq: 4,
            createdAtMs: 1003,
            role: 'agent' as const,
            content: { type: 'codex', provider: 'codex', data: { type: 'message', message: 'hidden codex assistant text' } },
            meta: null,
          },
          {
            seq: 5,
            createdAtMs: 1004,
            role: 'agent' as const,
            content: { type: 'codex', provider: 'codex', data: { type: 'reasoning', message: 'hidden codex reasoning trace' } },
            meta: null,
          },
          { seq: 6, createdAtMs: 1005, role: 'agent' as const, content: { type: 'text', text: 'visible plain assistant text' }, meta: null },
        ],
      });

      const visibleHits = deep.search({ query: 'visible prompt', scope: { type: 'global' }, maxResults: 10 });
      expect(visibleHits).toHaveLength(1);
      expect(deep.search({ query: 'plain assistant', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      expect(visibleHits[0]?.text).toContain('visible user prompt');
      expect(visibleHits[0]?.text).toContain('visible plain assistant text');
      expect(visibleHits[0]?.text).not.toContain('hidden acp assistant text');
      expect(visibleHits[0]?.text).not.toContain('hidden acp reasoning trace');
      expect(visibleHits[0]?.text).not.toContain('hidden codex assistant text');
      expect(visibleHits[0]?.text).not.toContain('hidden codex reasoning trace');

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('indexes semantic provider assistant rows into the deep index', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-provider-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      await syncDeepIndexForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async () => [
          {
            seq: 1,
            createdAtMs: 1000,
            role: 'agent' as const,
            content: { type: 'codex', provider: 'codex', data: { type: 'message', message: 'deep semantic openclaw provider row' } },
            meta: null,
          },
        ],
      });

      const hits = deep.search({ query: 'openclaw', scope: { type: 'global' }, maxResults: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0]!.sessionId).toBe('sess-1');

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('indexes new transcript rows into the deep index and advances the cursor', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'hello openclaw' }, meta: null },
        {
          seq: 2,
          createdAtMs: 1001,
          role: 'agent' as const,
          content: { type: 'text', text: '[memory]' },
          meta: { happier: { kind: 'session_summary_shard.v1', payload: {} } },
        },
        { seq: 3, createdAtMs: 1002, role: 'user' as const, content: { type: 'text', text: 'deep index is useful' }, meta: null },
      ];

      await syncDeepIndexForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((r) => r.seq > afterSeq) as any,
      });

      const hits = deep.search({ query: 'openclaw', scope: { type: 'global' }, maxResults: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0]!.sessionId).toBe('sess-1');

      const cursors = tier1.getSessionCursors({ sessionId: 'sess-1', nowMs: 10_000 });
      expect(cursors.lastDeepIndexedSeq).toBe(3);

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores embeddings for newly indexed chunks when enabled', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-emb-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'hello openclaw' }, meta: null },
        { seq: 2, createdAtMs: 1001, role: 'agent' as const, content: { type: 'text', text: 'deep index is useful' }, meta: null },
      ];

      await (syncDeepIndexForSessionsOnce as any)({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
          embeddings: {
            enabled: true,
            mode: 'custom',
            presetId: null,
            providerKind: 'test',
            modelId: 'm1',
            blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
            providerConfig: null,
          },
        },
        embedDocuments: async () => [new Float32Array([0.25, 0.5])],
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((r) => r.seq > afterSeq) as any,
      });

      const embeddingMap = deep.loadEmbeddings({
        provider: 'test',
        modelId: 'm1',
        keys: [{ sessionId: 'sess-1', seqFrom: 1, seqTo: 2 }],
      });
      expect(embeddingMap.get('sess-1:1-2')).toBeTruthy();

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills embeddings for existing chunks when embeddings become available later', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-deep-sync-backfill-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      const allRows = [
        { seq: 1, createdAtMs: 1000, role: 'user' as const, content: { type: 'text', text: 'hello openclaw' }, meta: null },
        { seq: 2, createdAtMs: 1001, role: 'agent' as const, content: { type: 'text', text: 'deep index is useful' }, meta: null },
      ];

      await (syncDeepIndexForSessionsOnce as any)({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 10_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }: { afterSeq: number }) =>
          allRows.filter((r) => r.seq > afterSeq) as any,
      });

      await (syncDeepIndexForSessionsOnce as any)({
        sessionIds: ['sess-1'],
        tier1,
        deep,
        now: () => 20_000,
        settings: {
          enabled: true,
          indexMode: 'deep',
          deep: {
            maxChunkChars: 8000,
            maxChunkMessages: 20,
            minChunkMessages: 1,
            includeAssistantAcpMessage: true,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
          embeddings: {
            enabled: true,
            mode: 'custom',
            presetId: null,
            providerKind: 'test',
            modelId: 'm1',
            blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
            providerConfig: null,
          },
        },
        embedDocuments: async () => [new Float32Array([0.25, 0.5])],
        fetchDecryptedTranscriptPageAfterSeq: async () => [],
      });

      const embeddingMap = deep.loadEmbeddings({
        provider: 'test',
        modelId: 'm1',
        keys: [{ sessionId: 'sess-1', seqFrom: 1, seqTo: 2 }],
      });
      expect(embeddingMap.get('sess-1:1-2')).toBeTruthy();

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
