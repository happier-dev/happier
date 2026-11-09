import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeExternalSessionsContribution } from '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/contribution';
import { createCodexExternalSessionsContribution } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution';
import { createPiExternalSessionsContribution } from '../../../../../packages/plugins/pi/src/agent/externalSessions/contribution';
import { createCopilotExternalSessionsContribution } from '../../../../../packages/plugins/copilot/src/agent/externalSessions/contribution';
import { normalizeMemorySettings } from '@happier-dev/protocol/memory/memorySettings';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { externalMemoryStorageId, syncExternalMemoryTranscriptOnce, syncExternalMemoryTranscriptsBatch, type MemoryExternalSourceReader } from './externalTranscriptIndex';
import { createBoundedAgentExternalSessionsContribution, EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createMemoryExternalTranscriptTraversal, discoverMemoryExternalTranscriptSources } from './externalTranscriptSources';
import { runMemoryWorkerSourcesTick } from './runMemoryWorkerSourcesTick';
import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { syncDeepIndexForSessionsOnce } from './deepIndex/syncDeepIndexForSessionsOnce';
import { enforceMemoryDiskBudgets } from './enforceMemoryDiskBudgets';
import { getMemoryWindow } from './getMemoryWindow';
import { hasConversationSearchScanFallback, searchConversations } from '../../../../../apps/ui/sources/sync/domains/search/searchConversations';
import { RPC_METHODS } from '@happier-dev/protocol';
import { MemoryIndexSourceStatusV1Schema } from '@happier-dev/protocol/memory/memoryStatus';
import { SearchConversationsResultV1Schema } from '@happier-dev/protocol/actions/actionSpecs';
import { logger } from '@/ui/logger';

// Only cross-device transports are replaced; ingestion, SQLite, readiness and
// the unified automatic-search decision remain real.
const transports = vi.hoisted(() => ({
  rpc: vi.fn<(request: { method: string }) => Promise<unknown>>(),
  list: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('../../../../../apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transports.rpc }));
vi.mock('../../../../../apps/ui/sources/sync/ops/machineExternalSessions', () => ({ machineExternalSessionsCandidatesList: transports.list }));

describe('external memory transcript ingestion', () => {
  it.each(['unknown event', 'torn tail'] as const)('reports an undecodable Copilot %s as unavailable without rescanning or hiding readable siblings', async defect => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-copilot-unavailable-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'summary.sqlite') });
    const lifetime = new AbortController();
    let nowMs = Date.now();
    try {
      const header = (id: string) => JSON.stringify({ type: 'session.start', id: 'start', timestamp: new Date().toISOString(),
        data: { sessionId: id, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.100' } }) + '\n';
      const message = JSON.stringify({ type: 'user.message', id: 'prompt', timestamp: new Date().toISOString(),
        data: { content: 'quartz native fact' } }) + '\n';
      for (const id of ['broken', 'readable']) {
        await mkdir(join(dir, 'session-state', id), { recursive: true });
        await writeFile(join(dir, 'session-state', id, 'events.jsonl'), header(id) + message);
      }
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createCopilotExternalSessionsContribution({ env: {} }),
        identity: { pluginId: 'fixture.copilot', agentId: 'copilot', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.copilot/agents/copilot', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: lifetime.signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const native = { agentId: 'copilot', sourceKey: 'local', source: { kind: 'copilotHome', homeDir: dir }, reader };
      const candidate = (nativeSessionId: string) => ({ native,
        source: { type: 'external_transcript' as const, agentId: 'copilot', sourceKey: 'local', nativeSessionId } });
      const broken = candidate('broken'), readable = candidate('readable');
      const traversal = createMemoryExternalTranscriptTraversal();
      traversal.replace([broken, readable]);
      const settings = normalizeMemorySettings({ enabled: true, indexMode: 'deep', coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['copilot'] } } });
      const sync = () => syncExternalMemoryTranscriptsBatch({ candidates: [broken, readable], db, tier1, settings,
        nowMs, signal: lifetime.signal, onSourceResult: traversal.noteSyncResult });
      await sync();
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'ready' }]);
      // A once-readable conversation must also retire its old searchable text.
      await appendFile(join(dir, 'session-state', 'broken', 'events.jsonl'), defect === 'unknown event'
        ? JSON.stringify({ type: 'future.message', id: 'unknown', data: { content: 'not decodable' } }) + '\n'
        : '{"type":"user.message","id":"torn","data":{"content":');
      await sync();
      expect(traversal.getIndexSources(db).map(row => MemoryIndexSourceStatusV1Schema.parse(row))).toMatchObject([
        { state: 'error', errorCode: 'unsupported', errorReason: 'external_sessions_transcript_read_failed' },
      ]);
      const hits = db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true });
      expect(hits.map(hit => hit.source)).toEqual([readable.source]);
      // After retiring the old tail, the initial-page path must refuse it too.
      nowMs = tier1.getSessionCursors({ sessionId: externalMemoryStorageId(broken.source), nowMs }).nextDeepEligibleAtMs;
      await sync();
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'unsupported' }]);
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true }).map(hit => hit.source)).toEqual([readable.source]);
      const restarted = createMemoryExternalTranscriptTraversal();
      restarted.replace([broken, readable]);
      expect(restarted.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'unsupported',
        errorReason: 'external_sessions_transcript_read_failed' }]);
      await syncExternalMemoryTranscriptsBatch({ candidates: [broken, readable], db, tier1, settings, nowMs,
        signal: lifetime.signal, onSourceResult: restarted.noteSyncResult });
      expect(restarted.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'unsupported',
        errorReason: 'external_sessions_transcript_read_failed' }]);
      transports.rpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return settings;
        if (request.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return {
          v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: true, deepIndexReady: true, activeIndexReady: true,
          embeddingsEnabled: false, embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
          embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
          tier1DbPath: null, deepDbPath: join(dir, 'deep.sqlite'), tier1DbBytes: 0, deepDbBytes: 0, sources: restarted.getIndexSources(db),
        };
        return { v: 1, ok: true, hits: [] };
      });
      transports.list.mockClear();
      transports.list.mockResolvedValue({ ok: true, candidates: [], contentCoverage: 'partial' });
      for (let query = 0; query < 2; query++) {
        const result = await searchConversations({ serverId: 'home', accountId: 'account', machines: [{ id: 'local', online: true }],
          mode: 'auto', query: { v: 1, query: 'quartz', scope: { type: 'global' }, corpora: ['external_transcripts'] },
          readSources: async () => [{ agentId: native.agentId, sourceKey: native.sourceKey, source: native.source, contentSearch: true }] });
        SearchConversationsResultV1Schema.parse(result);
        expect(result.failures).toEqual([{ machineId: 'local', agentId: 'copilot', sourceKey: 'local', errorCode: 'agent_unavailable', retryable: false }]);
        expect(hasConversationSearchScanFallback(result)).toBe(false);
      }
      expect(transports.list).not.toHaveBeenCalled();
      // An observed repair is not a permanent partial/unavailable flag.
      await writeFile(join(dir, 'session-state', 'broken', 'events.jsonl'), header('broken') + message);
      nowMs = tier1.getSessionCursors({ sessionId: externalMemoryStorageId(broken.source), nowMs }).nextDeepEligibleAtMs;
      await sync();
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'ready' }]);
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true })).toHaveLength(2);
    } finally { lifetime.abort(); db.close(); tier1.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('does not read every retained native frontier after a source group is already indexing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-native-status-cost-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    try {
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
        identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const native: MemoryExternalSourceReader = { agentId: 'claude', sourceKey: 'local',
        source: { kind: 'claudeConfig', configDir: dir }, reader };
      const candidates = Array.from({ length: 1001 }, (_, index) => ({ native,
        source: { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'local', nativeSessionId: `native-${index}` } }));
      const traversal = createMemoryExternalTranscriptTraversal();
      traversal.replace(candidates);
      for (const candidate of candidates.slice(1)) {
        db.setExternalSourceState({ sessionId: externalMemoryStorageId(candidate.source), source: candidate.source,
          cursor: JSON.stringify({ type: 'tail' }), nextOrdinal: 1 });
        traversal.noteSyncResult(candidate.source, 'current');
      }
      // Instrument the real SQLite frontier boundary; no read is substituted.
      const reads = vi.spyOn(db, 'getExternalSourceState');
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'indexing' }]);
      expect(reads.mock.calls.length).toBe(1);
      const pending = candidates[0]!;
      traversal.replace([]);
      traversal.replace([...candidates.slice(1), pending]);
      for (const candidate of candidates.slice(1)) traversal.noteSyncResult(candidate.source, 'current');
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'indexing' }]);
      expect(reads.mock.calls.length).toBe(2);
      db.setExternalSourceState({ sessionId: externalMemoryStorageId(pending.source), source: pending.source,
        cursor: JSON.stringify({ type: 'tail' }), nextOrdinal: 1 });
      traversal.noteSyncResult(pending.source, 'current');
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'ready' }]);
      traversal.noteSyncResult(candidates.at(-1)!.source, 'error', { errorCode: 'agent_unavailable' });
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'agent_unavailable' }]);
      reads.mockRestore();
    } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('reuses deep-index failure backoff for unavailable native reads and recovers when eligible', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-native-backoff-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'summary.sqlite') });
    const lifetime = new AbortController();
    let invocations = 0;
    try {
      await mkdir(join(dir, 'sessions'));
      const reader = createBoundedAgentExternalSessionsContribution({
        contribution: createCodexExternalSessionsContribution({ env: { CODEX_HOME: dir } }),
        identity: { pluginId: 'fixture.codex', agentId: 'codex', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.codex/agents/codex', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: lifetime.signal, isCurrent: () => true,
        createInvocationExec: async () => { invocations++; return createUnavailablePluginServices().exec; },
      });
      const source = { type: 'external_transcript' as const, agentId: 'codex', sourceKey: 'local', nativeSessionId: 'recoverable' };
      const native = { agentId: 'codex', sourceKey: 'local', source: { kind: 'codexHome', home: 'user' }, reader };
      const settings = normalizeMemorySettings({ enabled: true, indexMode: 'deep', coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['codex'] } } });
      const traversal = createMemoryExternalTranscriptTraversal();
      traversal.replace([{ source, native }]);
      const tick = (nowMs: number) => syncExternalMemoryTranscriptsBatch({
        candidates: traversal.take(1), db, tier1, settings, nowMs, signal: lifetime.signal, onSourceResult: traversal.noteSyncResult,
      });
      await tick(10_000);
      expect(invocations).toBe(1);
      await tick(10_001);
      expect(invocations).toBe(1);
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'agent_unavailable' }]);
      const sessionId = externalMemoryStorageId(source);
      const eligibleAt = 10_000 + settings.deep.failureBackoffBaseMs;
      expect(tier1.getSessionCursors({ sessionId, nowMs: 10_001 })).toMatchObject({ consecutiveDeepFailures: 1, nextDeepEligibleAtMs: eligibleAt });
      // A new child inherits persisted backoff, not the previous child's Map.
      const restarted = createMemoryExternalTranscriptTraversal();
      restarted.replace([{ source, native }]);
      await syncExternalMemoryTranscriptsBatch({ candidates: restarted.take(1), db, tier1, settings,
        nowMs: 10_001, signal: lifetime.signal, onSourceResult: restarted.noteSyncResult });
      expect(invocations).toBe(1);
      expect(restarted.hasPendingWork(), 'A future eligibility deadline must settle the current child').toBe(false);
      expect(restarted.getIndexSources(db)).toMatchObject([{ state: 'error' }]);
      await writeFile(join(dir, 'sessions', 'rollout-recoverable.jsonl'),
        JSON.stringify({ type: 'session_meta', payload: { id: 'recoverable' } }) + '\n'
        + JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'quartz recovery' }] } }) + '\n');
      await tick(eligibleAt);
      expect(invocations).toBe(2);
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true })).toHaveLength(1);
      expect(tier1.getSessionCursors({ sessionId, nowMs: eligibleAt })).toMatchObject({ consecutiveDeepFailures: 0, nextDeepEligibleAtMs: 0 });
    } finally { lifetime.abort(); db.close(); tier1.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('admits pre-existing Codex history while a sibling refresh and another backfill remain active', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-codex-initial-fairness-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    const lifetime = new AbortController();
    try {
      const project = join(dir, 'sessions');
      await mkdir(project);
      const timestamp = new Date(Date.now() - 60_000).toISOString();
      const row = (text: string) => JSON.stringify({ type: 'response_item', timestamp, payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text }],
      } }) + '\n';
      const write = async (id: string, count: number) => writeFile(join(project, `rollout-${id}.jsonl`),
        JSON.stringify({ type: 'session_meta', timestamp, payload: { id } }) + '\n'
        + Array.from({ length: count }, (_, ordinal) => row(`r278${id} ordinal${ordinal}${id === 'backfill' ? ' coastal walk'.repeat(600) : ''}`)).join(''));
      await write('main', 200);
      await write('backfill', 2000);
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createCodexExternalSessionsContribution({ env: { CODEX_HOME: dir } }),
        identity: { pluginId: 'fixture.codex', agentId: 'codex', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.codex/agents/codex', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: lifetime.signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const native = { agentId: 'codex', sourceKey: 'local', source: { kind: 'codexHome', home: 'user' }, reader };
      const candidate = (nativeSessionId: string) => ({ native,
        source: { type: 'external_transcript' as const, agentId: 'codex', sourceKey: 'local', nativeSessionId } });
      const main = candidate('main'), backfill = candidate('backfill'), sibling = candidate('sibling');
      const traversal = createMemoryExternalTranscriptTraversal();
      traversal.replace([backfill]);
      const settings = normalizeMemorySettings({ enabled: true, indexMode: 'deep', backfillPolicy: 'new_only',
        enabledAtMs: Date.now(), coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['codex'], historyDays: 1 } } });
      // A retained continuation and a continuously written discovered sibling
      // must leave an admission slot for the file that existed before opt-in.
      await syncExternalMemoryTranscriptsBatch({ candidates: traversal.take(1), db, settings, nowMs: Date.now(), signal: lifetime.signal,
        onSourceResult: traversal.noteSyncResult });
      expect(JSON.parse(db.getExternalSourceState({ sessionId: externalMemoryStorageId(backfill.source) })!.cursor!)).toMatchObject({ type: 'page' });
      await write('sibling', 2);
      traversal.replace([backfill, main, sibling], new Set([externalMemoryStorageId(sibling.source)]));
      const selected: string[] = [];
      // Two existing allowance rotations suffice for the three kinds of work;
      // this bounds the test, not the production scheduler or native reader.
      for (let turn = 0; turn < 8; turn++) {
        traversal.changed('codex', 'local', ['sibling']);
        const work = traversal.take(1);
        selected.push(...work.map(entry => entry.source.nativeSessionId));
        await syncExternalMemoryTranscriptsBatch({ candidates: work, db, settings, nowMs: Date.now(), signal: lifetime.signal,
          onSourceResult: traversal.noteSyncResult });
      }
      expect(selected).toContain('main');
      expect(db.getExternalSourceState({ sessionId: externalMemoryStorageId(main.source) })?.nextOrdinal).toBe(201);
      expect(db.search({ query: 'r278main', scope: { type: 'global' }, maxResults: 200, includeExternal: true })).toHaveLength(200);
      expect(db.search({ query: 'r278sibling', scope: { type: 'global' }, maxResults: 2, includeExternal: true })).toHaveLength(2);
    } finally { lifetime.abort(); db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('shares a multi-page Codex backfill with unstarted history without queueing each continuation behind the whole backlog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-codex-backfill-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    const lifetime = new AbortController();
    try {
      const id = '11111111-1111-4111-8111-111111111111';
      const project = join(dir, 'sessions', '2026', '10', '22');
      await mkdir(project, { recursive: true });
      const path = join(project, `rollout-2026-10-22T00-00-00-${id}.jsonl`);
      const timestamp = new Date().toISOString();
      const row = (index: number) => JSON.stringify({ type: 'response_item', timestamp, payload: {
        type: 'message', role: index % 2 ? 'assistant' : 'user', content: [{ type: index % 2 ? 'output_text' : 'input_text', text: `r252ordinal${index} café 東京 session_handoff. ${'A coastal walk passes cedar trees and a quiet harbor. '.repeat(132)}` }],
      } }) + '\n';
      await writeFile(path, JSON.stringify({ type: 'session_meta', timestamp, payload: { id, cwd: '/synthetic' } }) + '\n'
        + Array.from({ length: 200 }, (_, index) => row(index)).join(''));
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createCodexExternalSessionsContribution({ env: { CODEX_HOME: dir } }),
        identity: { pluginId: 'fixture.codex', agentId: 'codex', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.codex/agents/codex', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: lifetime.signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const source = { type: 'external_transcript' as const, agentId: 'codex', sourceKey: 'local', nativeSessionId: id };
      const native = { agentId: 'codex', sourceKey: 'local', source: { kind: 'codexHome', home: 'user' }, reader,
        observation: { lifetime: lifetime.signal } };
      const candidate = { source, native };
      const settings = normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['codex'], historyDays: 1 } } });
      const traversal = createMemoryExternalTranscriptTraversal();
      traversal.replace([candidate]);
      const sync = async () => {
        const selected = traversal.take(1);
        await syncExternalMemoryTranscriptsBatch({ candidates: selected, db, settings, nowMs: Date.now(), signal: lifetime.signal,
          onSourceResult: traversal.noteSyncResult });
      };
      const started = performance.now();
      await sync();
      const sessionId = externalMemoryStorageId(source);
      const first = db.getExternalSourceState({ sessionId })!;
      expect(JSON.parse(first.cursor!)).toMatchObject({ type: 'page' });
      // The stored retention bit alone is not initial-history completeness.
      // The canonical readiness owner also requires the exhausted frontier.
      expect(traversal.getIndexSources(db)).toMatchObject([{ state: 'indexing' }]);
      // The same scheduling queue in production can hold thousands of unstarted
      // native conversations. Continuation must not wait for every first page.
      const backlog = await Promise.all(Array.from({ length: 300 }, async (_, index) => {
        const nativeSessionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        await writeFile(join(project, `rollout-2026-10-22T00-00-00-${nativeSessionId}.jsonl`),
          JSON.stringify({ type: 'session_meta', timestamp, payload: { id: nativeSessionId, cwd: '/synthetic' } }) + '\n' + row(999));
        return { native, source: { ...source, nativeSessionId } };
      }));
      traversal.replace([candidate, ...backlog]);
      const pages = Math.ceil(200 / (first.nextOrdinal - 1));
      await sync();
      await sync();
      expect(db.listExternalSourceStates().some(state => state.source.nativeSessionId !== id),
        'pre-existing history must receive work while an admitted transcript is still backfilling').toBe(true);
      // The existing alternating allowance admits new history without making
      // a continuation wait for all 300 conversations to take their first page.
      for (let turn = 3; turn < pages * 2; turn++) await sync();
      console.info('R252_INITIAL_COVERAGE', JSON.stringify({ bytes: (await stat(path)).size, turns: pages * 2,
        indexedMessages: db.getExternalSourceState({ sessionId })!.nextOrdinal - 1, elapsedMs: performance.now() - started }));
      expect(db.getExternalSourceState({ sessionId })!.nextOrdinal).toBe(201);
      expect(db.getExternalSourceState({ sessionId })!.coverageComplete).toBe(true);
      const indexed = db.search({ query: 'coastal', scope: { type: 'session', sessionId }, maxResults: 201, includeExternal: true });
      expect(indexed).toHaveLength(200);
      expect(indexed.map(hit => Number(/r252ordinal(\d+)\b/.exec(hit.text)?.[1])).sort((a, b) => a - b))
        .toEqual(Array.from({ length: 200 }, (_, index) => index));
      const pageBoundary = 200 - (first.nextOrdinal - 1) - 1;
      for (const ordinal of [0, 100, pageBoundary, 199]) {
        const hit = indexed.find(item => new RegExp(`r252ordinal${ordinal}\\b`).test(item.text))!;
        const readWindow = async (useIndex: boolean, cursor?: string) => {
          let reads = 0;
          const started = performance.now();
          const window = await getMemoryWindow({ source, sourceItemId: hit.sourceItemId!,
            paddingMessages: 8, signal: lifetime.signal, db: useIndex ? db : undefined, ...(cursor ? { cursor } : {}),
            fetchExternalTranscriptPage: async request => {
              reads++;
              const page = await reader.pageTranscript({ source: native.source, remoteSessionId: id, direction: 'older',
                ...(request.cursor ? { cursor: request.cursor } : {}), observation: native.observation,
                ...EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript, signal: lifetime.signal });
              if (!page.ok) throw new Error(`${page.code}:${page.message}`);
              return page.value;
            },
          });
          return { window, reads, elapsedMs: performance.now() - started };
        };
        const baseline = ordinal === 0 ? await readWindow(false) : undefined;
        const { window, reads, elapsedMs } = await readWindow(true);
        expect(window.externalSnippets?.some(item => item.sourceItemId === hit.sourceItemId)).toBe(true);
        console.info('R261_WINDOW', JSON.stringify({ ordinal, reads, elapsedMs,
          ...(baseline ? { baselineReads: baseline.reads, baselineElapsedMs: baseline.elapsedMs } : {}) }));
        // An indexed head hit already has a reader-owned page locator. Omitting
        // the optional wire cursor must not decode the entire history again.
        if (ordinal === 0) expect(reads).toBe(1);
        if (baseline) expect(window.externalSnippets?.map(item => item.text)).toEqual(baseline.window.externalSnippets?.map(item => item.text));
        expect(window.externalSnippets?.length).toBe(ordinal === 0 || ordinal === 199 ? 9 : 17);
        if (ordinal === pageBoundary) {
          expect(hit.sourceCursor).toBeTruthy();
          const explicit = await readWindow(false, hit.sourceCursor!);
          expect(explicit.window.externalSnippets?.map(item => item.sourceItemId))
            .toEqual(window.externalSnippets?.map(item => item.sourceItemId));
        }
      }
      await appendFile(path, row(200));
      traversal.changed('codex', 'local', [id]);
      // One of each two selections serves requested refreshes.
      for (let turn = 0; turn < 2; turn++) await sync();
      expect(db.search({ query: 'r252ordinal200', scope: { type: 'global' }, maxResults: 1, includeExternal: true })).toHaveLength(1);
      expect(db.getExternalSourceState({ sessionId })!.nextOrdinal).toBe(202);
      expect(db.search({ query: 'coastal', scope: { type: 'session', sessionId }, maxResults: 201, includeExternal: true })
        .map(hit => Number(/r252ordinal(\d+)\b/.exec(hit.text)?.[1])).sort((a, b) => a - b))
        .toEqual(Array.from({ length: 201 }, (_, index) => index));
      console.info('R252_BACKFILL', JSON.stringify({ bytes: (await stat(path)).size, firstPageMessages: first.nextOrdinal - 1,
        pages, messages: 201, elapsedMs: performance.now() - started }));
    } finally { lifetime.abort(); db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it.each([2, 200])('retires an unlinked Codex rollout in every source partition after %i messages', async count => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-codex-retire-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    const lifetime = new AbortController();
    try {
      const id = 'd4b84a10-0e52-44fa-8147-268000000002';
      const project = join(dir, 'sessions', '2026', '10', '22');
      await mkdir(project, { recursive: true });
      const path = join(project, `rollout-2026-10-22T00-00-00-${id}.jsonl`);
      const timestamp = new Date().toISOString();
      await writeFile(path, JSON.stringify({ type: 'session_meta', timestamp, payload: { id, cwd: '/synthetic' } }) + '\n'
        + Array.from({ length: count }, (_, ordinal) => JSON.stringify({ type: 'response_item', timestamp, payload: {
          type: 'message', role: ordinal % 2 ? 'assistant' : 'user', content: [{ type: ordinal % 2 ? 'output_text' : 'input_text',
            text: `r268retirement ordinal${ordinal} café 東京 ${'coastal walk '.repeat(count > 2 ? 600 : 1)}` }],
        } }) + '\n').join(''));
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createCodexExternalSessionsContribution({ env: { CODEX_HOME: dir } }),
        identity: { pluginId: 'fixture.codex', agentId: 'codex', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.codex/agents/codex', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: lifetime.signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const settings = normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['codex'], historyDays: 1 } } });
      const candidates = ['user-home', 'linked-home'].map(sourceKey => ({
        source: { type: 'external_transcript' as const, agentId: 'codex', sourceKey, nativeSessionId: id },
        native: { agentId: 'codex', sourceKey, source: { kind: 'codexHome', home: 'user' }, reader },
      }));
      for (const candidate of candidates) {
        await syncExternalMemoryTranscriptOnce({ ...candidate, db, settings, nowMs: Date.now(), signal: lifetime.signal });
        expect(db.getExternalSourceState({ sessionId: externalMemoryStorageId(candidate.source) })?.nextOrdinal).toBeGreaterThan(1);
      }
      await rm(path);
      for (const candidate of candidates) {
        await expect(syncExternalMemoryTranscriptOnce({ ...candidate, db, settings, nowMs: Date.now(), signal: lifetime.signal })).resolves.toBe('removed');
        expect(db.getExternalSourceState({ sessionId: externalMemoryStorageId(candidate.source) })).toBeNull();
      }
      expect(db.search({ query: 'r268retirement', scope: { type: 'global' }, maxResults: 400, includeExternal: true })).toEqual([]);
    } finally { lifetime.abort(); db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it.each(['malformed', 'oversized'] as const)('keeps a safe Codex %s failure through bounded ingestion and source status', async failure => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-codex-failure-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    const diagnostic = vi.spyOn(logger, 'debug');
    try {
      const id = '11111111-1111-4111-8111-111111111111';
      const project = join(dir, 'sessions', '2026', '10', '21');
      await mkdir(project, { recursive: true });
      const malformed = Buffer.concat([
        Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/synthetic' } }) + '\n'),
        Buffer.from('{"type":"response_item","payload":{"type":"message","role":"user","content":"'),
        Buffer.from([0xff, 0xfe]), Buffer.from('"}}\n'),
      ]);
      const oversized = JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/synthetic' } }) + '\n'
        + JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'x'.repeat(EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes) }] } }) + '\n';
      await writeFile(join(project, `rollout-2026-10-21T00-00-00-${id}.jsonl`), failure === 'malformed' ? malformed : oversized);
      const reason = failure === 'malformed' ? 'external_sessions_transcript_read_failed' : 'external_sessions_transcript_page_byte_budget';
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createCodexExternalSessionsContribution({ env: { CODEX_HOME: dir } }),
        identity: { pluginId: 'fixture.codex', agentId: 'codex', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.codex/agents/codex', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const source = { type: 'external_transcript' as const, agentId: 'codex', sourceKey: 'local', nativeSessionId: id };
      const candidate = { source, native: { agentId: 'codex', sourceKey: 'local', source: { kind: 'codexHome', home: 'user' }, reader } };
      const settings = normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
        coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: { enabled: true, agents: ['codex'] } } });
      const traversal = createMemoryExternalTranscriptTraversal();
      const goodId = '22222222-2222-4222-8222-222222222222';
      await writeFile(join(project, `rollout-2026-10-21T00-00-00-${goodId}.jsonl`),
        JSON.stringify({ type: 'session_meta', payload: { id: goodId, cwd: '/synthetic' } }) + '\n'
        + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'r273goodsource continues indexing' }] } }) + '\n');
      const good = { ...candidate, source: { ...source, nativeSessionId: goodId } };
      traversal.replace([candidate, good]);
      const signal = new AbortController().signal;
      await expect(runMemoryWorkerSourcesTick({ sessionIds: [], externalSourceCount: 2, cursor: 0, maxSessions: 2, signal,
        syncSessions: async () => {},
        syncExternalSources: async maxSources => syncExternalMemoryTranscriptsBatch({ candidates: traversal.take(maxSources), db, settings,
          nowMs: Date.now(), signal, onSourceResult: traversal.noteSyncResult }),
      })).resolves.toBe(0);
      expect(db.search({ query: 'r273goodsource', scope: { type: 'global' }, maxResults: 1, includeExternal: true })).toHaveLength(1);
      expect(traversal.getIndexSources(db).map(row => MemoryIndexSourceStatusV1Schema.parse(row))).toMatchObject([{ state: 'error', errorCode: 'agent_error', errorReason: reason }]);
      expect(diagnostic).toHaveBeenCalledWith('[memoryWorker] Native source read failed', {
        agentId: 'codex', code: 'agent_error', reason,
      });
      if (failure === 'malformed') {
        expect(diagnostic).toHaveBeenCalledWith('[codex] Native transcript read failed', {
          exceptionClass: 'Error', code: 'CODEX_TRANSCRIPT_MALFORMED_UTF8', phase: 'page_scan',
          sourceItemId: id, fileBasename: `rollout-2026-10-21T00-00-00-${id}.jsonl`, byteOffset: expect.any(Number),
        });
      }
      expect(MemoryIndexSourceStatusV1Schema.safeParse({ source: { type: 'external_transcript', agentId: 'codex', sourceKey: 'local' },
        state: 'error', errorReason: `/private/${id}/transcript text` }).success).toBe(false);
      await writeFile(join(project, `rollout-2026-10-21T00-00-00-${id}.jsonl`),
        JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/synthetic' } }) + '\n');
      await syncExternalMemoryTranscriptsBatch({ candidates: [candidate], db, settings, nowMs: Date.now(),
        signal: new AbortController().signal, onSourceResult: traversal.noteSyncResult });
      expect(traversal.getIndexSources(db)).toEqual([{ source: { type: 'external_transcript', agentId: 'codex', sourceKey: 'local' }, state: 'ready' }]);
    } finally { diagnostic.mockRestore(); db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('retains the bounded native reader failure reason without exposing native content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-native-failure-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    try {
      const project = join(dir, 'projects', 'project');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, 'native.jsonl'), Buffer.from([0xff, 0x0a]));
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
        identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const settings = normalizeMemorySettings({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
        coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
      await expect(syncExternalMemoryTranscriptOnce({
        source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local', nativeSessionId: 'native' },
        native: { agentId: 'claude', sourceKey: 'local', source: { kind: 'claudeConfig', configDir: dir }, reader },
        db, settings, nowMs: Date.now(), signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'agent_error', reason: 'external_sessions_transcript_read_failed' });
    } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('admits cancellation between native chunk writes while keeping committed progress searchable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-native-cancel-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    const controller = new AbortController();
    let finished = false;
    let observer: NodeJS.Immediate | undefined;
    try {
      const project = join(dir, 'projects', 'project');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, 'native.jsonl'), Array.from({ length: 100 }, (_, index) => JSON.stringify({
        type: 'user', uuid: String(index), sessionId: 'native', timestamp: '2026-10-21T00:00:00Z',
        message: { role: 'user', content: `quartz cancellable native fact ${index}` },
      }) + '\n').join(''));
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
        identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const observe = () => {
        if (finished) return;
        if (db.getDeepIndexStats().deepChunkCount > 0) controller.abort(new Error('stop native indexing'));
        else observer = setImmediate(observe);
      };
      observer = setImmediate(observe);
      const settings = normalizeMemorySettings({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
        coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
      await expect(syncExternalMemoryTranscriptOnce({
        source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local', nativeSessionId: 'native' },
        native: { agentId: 'claude', sourceKey: 'local', source: { kind: 'claudeConfig', configDir: dir }, reader },
        db, settings, nowMs: Date.now(), signal: controller.signal,
      })).rejects.toThrow('stop native indexing');
      expect(db.getDeepIndexStats().deepChunkCount).toBeGreaterThan(0);
      expect(db.getDeepIndexStats().deepChunkCount).toBeLessThan(100);
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 1, includeExternal: true })).toHaveLength(1);
    } finally { finished = true; if (observer) clearImmediate(observer); db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('keeps reader progress after budget eviction but exposes lost coverage to automatic scan fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-native-eviction-'));
    const dbPath = join(dir, 'deep.sqlite');
    let db = openDeepIndexDb({ dbPath });
    const tier1Path = join(dir, 'hints.sqlite');
    const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
    try {
      db.init(); tier1.init();
      const project = join(dir, 'projects', 'project');
      await mkdir(project, { recursive: true });
      const path = join(project, 'native.jsonl');
      const row = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, sessionId: 'native',
        timestamp: '2026-10-09T12:00:00Z', message: { role: 'user', content: text } }) + '\n';
      await writeFile(path, row('first', 'quartz native fact'));
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
        identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const source = { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'local', nativeSessionId: 'native' };
      const native = { agentId: 'claude', sourceKey: 'local', source: { kind: 'claudeConfig', configDir: dir }, reader };
      const settings = normalizeMemorySettings({ v: 1, enabled: true, backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
      const traversal = createMemoryExternalTranscriptTraversal();
      traversal.replace([{ source, native }]);
      const sync = () => syncExternalMemoryTranscriptsBatch({ candidates: [{ source, native }], db, settings,
        nowMs: Date.now(), signal: new AbortController().signal, onSourceResult: traversal.noteSyncResult });
      await sync();
      const sessionId = externalMemoryStorageId(source);
      const frontier = db.getExternalSourceState({ sessionId });
      expect(frontier?.cursor).toBeTruthy();
      expect(traversal.getIndexSources(db)[0]?.state).toBe('ready');
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true })).toHaveLength(1);

      transports.rpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return settings;
        if (request.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return {
          v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: true, deepIndexReady: true, activeIndexReady: true,
          embeddingsEnabled: false, embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
          embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
          tier1DbPath: tier1Path, deepDbPath: dbPath, tier1DbBytes: 0, deepDbBytes: 0, sources: traversal.getIndexSources(db),
        };
        return { v: 1, ok: true, hits: [] };
      });
      transports.list.mockResolvedValue({ ok: true, candidates: [{ remoteSessionId: 'native', updatedAtMs: Date.now(),
        match: { sourceItemId: 'first', messageIndex: 0, snippet: 'quartz native fact' } }], contentCoverage: 'complete' });
      const autoSearch = () => searchConversations({ serverId: 'home', accountId: 'account', machines: [{ id: 'local', online: true }],
        mode: 'auto', concurrencyLimit: 1, query: { v: 1, query: 'quartz', mode: 'auto', scope: { type: 'global' }, corpora: ['external_transcripts'] },
        readSources: async () => [{ agentId: 'claude', sourceKey: 'local', source: { kind: 'claudeConfig', configDir: dir }, contentSearch: true }] });
      expect((await autoSearch()).machines[0]?.status).toBe('ok');
      expect(transports.list).not.toHaveBeenCalled();
      await enforceMemoryDiskBudgets({ tier1, deep: db, tier1DbPath: tier1Path, deepDbPath: dbPath,
        budgets: { tier1Bytes: Number.MAX_SAFE_INTEGER, deepBytes: 0 } });
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true })).toEqual([]);
      expect(db.getExternalSourceState({ sessionId })).toMatchObject({ cursor: frontier!.cursor, nextOrdinal: frontier!.nextOrdinal });
      expect.soft(traversal.getIndexSources(db)[0]?.state).not.toBe('ready');
      // An unchanged tail, a reopened DB and then an append cannot restore the
      // historical coverage that eviction removed.
      db.close(); db = openDeepIndexDb({ dbPath });
      await sync();
      expect.soft(traversal.getIndexSources(db)[0]?.state).not.toBe('ready');
      await appendFile(path, row('second', 'garnet later fact'));
      await sync();
      expect(db.search({ query: 'garnet', scope: { type: 'global' }, maxResults: 10, includeExternal: true })).toHaveLength(1);
      expect.soft(traversal.getIndexSources(db)[0]?.state).not.toBe('ready');
      expect((await autoSearch()).hits).toMatchObject([{ mode: 'standard', candidate: {
        remoteSessionId: 'native', match: { snippet: 'quartz native fact' },
      } }]);
      // A real rebuild is the recovery that restores full coverage.
      db.deleteSessionIndexData({ sessionId });
      await sync();
      expect(traversal.getIndexSources(db)[0]?.state).toBe('ready');
    } finally { transports.rpc.mockReset(); transports.list.mockReset();
      db.close(); tier1.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('prunes the rolling history window even when the native tail has not changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-native-history-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    try {
      const project = join(dir, 'projects', 'project');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, 'native.jsonl'), JSON.stringify({ type: 'user', uuid: 'first', sessionId: 'native',
        timestamp: '2026-10-09T12:00:00Z', message: { role: 'user', content: 'quartz expiring native fact' } }) + '\n');
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
        identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const source = { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'local', nativeSessionId: 'native' };
      const native = { agentId: 'claude', sourceKey: 'local', source: { kind: 'claudeConfig', configDir: dir }, reader };
      const settings = normalizeMemorySettings({ v: 1, enabled: true, backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['claude'], historyDays: 1 } } });
      const sync = (nowMs: number) => syncExternalMemoryTranscriptOnce({ source, native, db, settings, nowMs, signal: new AbortController().signal });
      expect(await sync(Date.parse('2026-10-09T13:00:00Z'))).toBe('current');
      const search = () => db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true });
      expect(search()).toHaveLength(1);
      const frontier = db.getExternalSourceState({ sessionId: externalMemoryStorageId(source) });
      expect(await sync(Date.parse('2026-10-12T13:00:00Z'))).toBe('current');
      expect(search()).toEqual([]);
      expect(db.getExternalSourceState({ sessionId: externalMemoryStorageId(source) })).toEqual(frontier);
    } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('indexes healthy selected native sources despite a retired sibling and still observes cancellation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-native-batch-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    try {
      db.init();
      const project = join(dir, 'projects', 'project');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, 'healthy.jsonl'), JSON.stringify({ type: 'user', uuid: 'first', sessionId: 'healthy',
        timestamp: '2026-10-09T12:00:00Z', message: { role: 'user', content: 'quartz healthy native fact' } }) + '\n');
      const createCandidate = (nativeSessionId: string, retirement: AbortController) => {
        const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
          identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: nativeSessionId,
            contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
          retirementSignal: retirement.signal, isCurrent: () => !retirement.signal.aborted,
          createInvocationExec: async () => createUnavailablePluginServices().exec });
        return { source: { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'local', nativeSessionId },
          native: { agentId: 'claude', sourceKey: 'local', source: { kind: 'claudeConfig', configDir: dir }, reader } };
      };
      const retirement = new AbortController();
      const broken = createCandidate('retired', retirement);
      retirement.abort();
      const healthy = createCandidate('healthy', new AbortController());
      const settings = normalizeMemorySettings({ enabled: true, backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
      const operation = { candidates: [broken, healthy], db, settings, nowMs: Date.now(), signal: new AbortController().signal };
      const traversal = createMemoryExternalTranscriptTraversal();
      traversal.replace(operation.candidates);
      expect(traversal.getIndexSources?.(db).every(row => row.state === 'indexing')).toBe(true);
      await expect(syncExternalMemoryTranscriptsBatch({ ...operation,
        onSourceResult: (source, state) => traversal.noteSyncResult(source, state),
      })).resolves.toBeUndefined();
      expect(traversal.getIndexSources?.(db)).toEqual([{ source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local' }, state: 'error' }]);
      traversal.replace([healthy]);
      expect(traversal.getIndexSources?.(db)).toEqual([{ source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local' }, state: 'ready' }]);
      traversal.invalidate('claude', 'local');
      expect(traversal.getIndexSources?.(db)).toEqual([{ source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local' }, state: 'indexing' }]);
      await syncExternalMemoryTranscriptsBatch({ ...operation, candidates: [healthy], onSourceResult: traversal.noteSyncResult });
      expect(traversal.getIndexSources?.(db)[0]?.state).toBe('ready');
      await syncExternalMemoryTranscriptsBatch({ ...operation, candidates: [healthy], onSourceResult: traversal.noteSyncResult });
      expect(traversal.getIndexSources(db)[0]!.state).toBe('ready');
      const hits = db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.source).toEqual(healthy.source);
      db.deleteSessionIndexData({ sessionId: externalMemoryStorageId(healthy.source) });
      expect(traversal.getIndexSources?.(db)[0]?.state).toBe('indexing');
      const cancellation = new AbortController();
      cancellation.abort(new Error('Containing native batch cancelled'));
      await expect(syncExternalMemoryTranscriptsBatch({ ...operation, signal: cancellation.signal })).rejects.toThrow('Containing native batch cancelled');
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 10, includeExternal: true })).toEqual([]);
    } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('continues native traversal through identical and reordered inventory refreshes', () => {
    const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
      identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: 'current',
        contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
      retirementSignal: new AbortController().signal, isCurrent: () => true,
      createInvocationExec: async () => createUnavailablePluginServices().exec });
    const native: MemoryExternalSourceReader = { agentId: 'claude', sourceKey: 'local',
      source: { kind: 'claudeConfig', configDir: '/fixture/claude' }, reader };
    const candidates = ['alpha', 'beta', 'gamma'].map(nativeSessionId => ({ native,
      source: { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'local', nativeSessionId } }));
    const traversal = createMemoryExternalTranscriptTraversal();
    const nextId = () => traversal.take(1).map(candidate => candidate.source.nativeSessionId);
    expect(traversal.hasPendingWork()).toBe(false);
    traversal.replace(candidates);
    expect(traversal.hasPendingWork()).toBe(true);
    expect(nextId()).toEqual(['alpha']);
    traversal.replace(candidates);
    expect.soft(nextId()).toEqual(['beta']);
    traversal.replace([candidates[2]!, candidates[0]!, candidates[1]!]);
    expect.soft(nextId()).toEqual(['gamma']);
    traversal.replace([candidates[1]!, candidates[2]!, candidates[0]!]);
    expect.soft(nextId()).toEqual(['alpha']);
    traversal.replace([candidates[2]!]);
    expect(nextId()).toEqual(['gamma']);
    traversal.replace([]);
    expect(traversal.size()).toBe(0);
    expect(nextId()).toEqual([]);
    traversal.replace(candidates);
    expect(nextId()).toEqual(['alpha']);
    for (const candidate of candidates) traversal.noteSyncResult(candidate.source, 'current');
    expect(traversal.hasPendingWork()).toBe(false);
    traversal.noteSyncResult(candidates[0]!.source, 'more');
    expect(traversal.hasPendingWork()).toBe(true);
    traversal.noteSyncResult(candidates[0]!.source, 'current');
    traversal.changed('claude', 'local', ['beta']);
    expect(traversal.hasPendingWork()).toBe(true);
    traversal.noteSyncResult(candidates[1]!.source, 'error');
    expect(traversal.hasPendingWork()).toBe(false);
  });
  it('rebuilds a rewritten Claude conversation while unrelated initial history continues', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-rewrite-priority-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    try {
      const project = join(dir, 'projects', 'project');
      await mkdir(project, { recursive: true });
      const row = (id: string, text: string) => JSON.stringify({ type: 'user', uuid: id,
        sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n';
      const rewrittenPath = join(project, 'rewritten.jsonl');
      await writeFile(rewrittenPath, row('rewritten', 'quartz original conversation'));
      for (let index = 0; index < 6; index++) {
        await writeFile(join(project, `backfill-${index}.jsonl`), row(`backfill-${index}`, 'zircon initial history'));
      }
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
        identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const native: MemoryExternalSourceReader = { agentId: 'claude', sourceKey: 'local',
        source: { kind: 'claudeConfig', configDir: dir }, reader };
      const candidate = (nativeSessionId: string) => ({ native,
        source: { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'local', nativeSessionId } });
      const rewritten = candidate('rewritten');
      const settings = normalizeMemorySettings({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
        coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
      const traversal = createMemoryExternalTranscriptTraversal();
      const operation = { db, settings, nowMs: Date.now(), signal: new AbortController().signal,
        onSourceResult: traversal.noteSyncResult };
      traversal.replace([rewritten]);
      await syncExternalMemoryTranscriptsBatch({ ...operation, candidates: traversal.take(1) });
      const search = (query: string) => db.search({ query, scope: { type: 'global' }, maxResults: 10,
        includeExternal: true, includeSessions: false });
      expect(search('quartz')).toHaveLength(1);
      traversal.replace([rewritten, ...Array.from({ length: 6 }, (_, index) => candidate(`backfill-${index}`))]);
      // Same native identity and record count; only the readable text changes.
      await writeFile(rewrittenPath, row('rewritten', 'garnet replacement conversation'));
      traversal.changed('claude', 'local', ['rewritten']);
      // One tick advances initial history, one detects replacement, and the
      // next two must serve both backfill and the requested reconstruction.
      for (let tick = 0; tick < 4; tick++) {
        await syncExternalMemoryTranscriptsBatch({ ...operation, candidates: traversal.take(1) });
      }
      expect(search('quartz')).toEqual([]);
      expect(search('garnet')).toHaveLength(1);
      expect(search('zircon').length).toBeGreaterThan(0);
      expect(search('zircon').length).toBeLessThan(6);
    } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('shares each worker tick budget across persistent Happier and native candidates without starving either', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-mixed-tick-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
    const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'hints.sqlite') });
    try {
      db.init(); tier1.init();
      const project = join(dir, 'projects', 'project');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, 'native.jsonl'), JSON.stringify({ type: 'user', uuid: 'first', sessionId: 'native',
        timestamp: '2026-10-09T12:00:00Z', message: { role: 'user', content: 'quartz native fact' } }) + '\n');
      const readerRetirement = new AbortController();
      const reader = createBoundedAgentExternalSessionsContribution({ contribution: createClaudeExternalSessionsContribution({ env: {} }),
        identity: { pluginId: 'fixture.claude', agentId: 'claude', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.claude/agents/claude', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } }, retirementSignal: readerRetirement.signal,
        isCurrent: () => true, createInvocationExec: async () => createUnavailablePluginServices().exec });
      const source = { type: 'external_transcript' as const, agentId: 'claude', sourceKey: 'local', nativeSessionId: 'native' };
      const native = { agentId: 'claude', sourceKey: 'local', source: { kind: 'claudeConfig', configDir: dir }, reader };
      const settings = normalizeMemorySettings({ enabled: true, backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
        conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
      let cursor = 0;
      let nativeSignal = new AbortController().signal;
      let happierSeq = 1;
      let happierText = 'amethyst Happier fact';
      const tick = async (maxSessions = 1, prepareExternalSources?: () => Promise<number>, finishTick?: () => Promise<void>) => {
        const nextCursor = await runMemoryWorkerSourcesTick({ sessionIds: ['happier'], externalSourceCount: 1, cursor, maxSessions,
          prepareExternalSources,
          finishTick,
          advanceCursor: next => { cursor = next; },
          syncExternalSources: async count => {
            for (let i = 0; i < count; i++) await syncExternalMemoryTranscriptOnce({ source, native, db, settings,
              nowMs: Date.now(), signal: nativeSignal });
          },
          syncSessions: async sessionIds => {
            await syncDeepIndexForSessionsOnce({ sessionIds, deep: db, tier1, now: Date.now,
              settings: { ...settings, indexMode: 'deep' },
              fetchDecryptedTranscriptPageAfterSeq: async ({ afterSeq }) => afterSeq < happierSeq
                ? [{ seq: happierSeq, createdAtMs: 1000, role: 'user', content: { type: 'text', text: happierText } }] : [] });
          },
        });
        cursor = nextCursor;
      };
      const search = (query: string) => db.search({ query, scope: { type: 'global' }, maxResults: 10, includeExternal: true, includeSessions: true });
      await tick();
      expect(search('amethyst').length + search('quartz').length).toBe(1);
      await tick();
      expect(search('amethyst')).toHaveLength(1);
      expect(search('quartz')).toHaveLength(1);
      await tick();
      expect(search('amethyst').length + search('quartz').length).toBe(2);
      const failedNativeRead = new AbortController();
      failedNativeRead.abort(new Error('Native source read cancelled'));
      nativeSignal = failedNativeRead.signal;
      await expect(tick()).rejects.toThrow('Native source read cancelled');
      nativeSignal = new AbortController().signal;
      happierSeq = 2;
      happierText = 'sapphire recovered Happier fact';
      await tick();
      expect.soft(search('sapphire')).toHaveLength(1);
      // Plugin retirement is a native reader failure, not cancellation of the
      // containing worker tick. Its selected Happier work must still progress.
      readerRetirement.abort();
      happierSeq = 3;
      happierText = 'opal independent Happier fact';
      await expect(tick(2)).rejects.toThrow();
      expect.soft(search('opal')).toHaveLength(1);
      happierSeq = 4;
      happierText = 'ruby Happier fact after native preparation failure';
      await expect(tick(2, async () => { await stat(join(dir, 'unavailable-native-root')); return 1; })).rejects.toMatchObject({ code: 'ENOENT' });
      expect(search('ruby')).toHaveLength(1);
      happierSeq = 5;
      happierText = 'emerald partial-turn Happier fact';
      await expect(tick(2, undefined, () => enforceMemoryDiskBudgets({ tier1, deep: db,
        tier1DbPath: join(dir, 'hints.sqlite'), deepDbPath: join(dir, 'deep.sqlite'),
        budgets: { tier1Bytes: 0, deepBytes: 0 } }))).rejects.toThrow();
      expect(search('emerald')).toEqual([]);
      expect(search('quartz')).toEqual([]);
    } finally { db.close(); tier1.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('preserves configured topology when a native runtime is retired during discovery', async () => {
    const ingestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!ingestion.ok) throw new Error(JSON.stringify(ingestion.diagnostics));
    const agents = ingestion.manifest.contributes.agents.map(definition => projectManifestAgentContribution({
      definition, pluginId: ingestion.manifest.id, provenance: 'first_party', source: { kind: 'bundled' },
    }));
    const retirement = new AbortController();
    const contribution = createClaudeExternalSessionsContribution({ env: { CLAUDE_CONFIG_DIR: '/fixture/claude' } });
    const bounded = createBoundedAgentExternalSessionsContribution({ contribution,
      identity: { pluginId: ingestion.manifest.id, agentId: 'claude', occurrenceId: 'retired',
        contributionQualifiedId: `${ingestion.manifest.id}/agents/claude`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
      retirementSignal: retirement.signal, isCurrent: () => !retirement.signal.aborted,
      createInvocationExec: async () => createUnavailablePluginServices().exec });
    retirement.abort();
    const result = await discoverMemoryExternalTranscriptSources({ agents, account: { connectedServicesV2: [] },
      activeServerId: 'home', activeServerDir: '/fixture/home', signal: new AbortController().signal,
      resolveBoundary: async () => ({ catalogEntry: null, externalSessions: bounded, occurrenceId: 'retired', retirementSignal: retirement.signal,
        isCurrent: () => !retirement.signal.aborted }) });
    expect(result.descriptors).toEqual([]);
    expect(result.configuredSourceKeys.size).toBe(1);
    const liveRetirement = new AbortController();
    const live = createBoundedAgentExternalSessionsContribution({ contribution,
      identity: { pluginId: ingestion.manifest.id, agentId: 'claude', occurrenceId: 'live',
        contributionQualifiedId: `${ingestion.manifest.id}/agents/claude`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
      retirementSignal: liveRetirement.signal, isCurrent: () => true,
      createInvocationExec: async () => createUnavailablePluginServices().exec });
    const available = await discoverMemoryExternalTranscriptSources({ agents, account: { connectedServicesV2: [] },
      activeServerId: 'home', activeServerDir: '/fixture/home', signal: new AbortController().signal,
      resolveBoundary: async () => ({ catalogEntry: null, externalSessions: live, occurrenceId: 'live', retirementSignal: liveRetirement.signal,
        isCurrent: () => true }) });
    expect(available.descriptors).toHaveLength(1);
    expect(available.configuredSourceKeys.has(JSON.stringify(['claude', available.descriptors[0]?.configuredSourceKey]))).toBe(true);
    expect((await discoverMemoryExternalTranscriptSources({ agents: [], account: { connectedServicesV2: [] },
      activeServerId: 'home', activeServerDir: '/fixture/home', signal: new AbortController().signal,
      resolveBoundary: async () => null })).configuredSourceKeys.size).toBe(0);
  });
  it('round-trips a real Codex semantic continuation through the host response budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-codex-continuation-'));
    try {
      const project = join(dir, 'sessions', '2026', '10', '09');
      await mkdir(project, { recursive: true });
      const path = join(project, 'rollout-2026-10-09T12-00-00-native-session.jsonl');
      const row = (value: unknown) => JSON.stringify(value) + '\n';
      await writeFile(path, row({ type: 'session_meta', timestamp: '2026-10-09T12:00:00Z',
        payload: { id: 'native-session', timestamp: '2026-10-09T12:00:00Z', cwd: '/workspace' } })
        + row({ type: 'response_item', timestamp: '2026-10-09T12:00:00Z', payload: { type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'before native collaboration' }] } }));
      const reader = createBoundedAgentExternalSessionsContribution({
        contribution: createCodexExternalSessionsContribution({ env: { CODEX_HOME: dir } }),
        identity: { pluginId: 'fixture.codex', agentId: 'codex', occurrenceId: 'current',
          contributionQualifiedId: 'fixture.codex/agents/codex', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const request = { source: { kind: 'codexHome', home: 'user' }, remoteSessionId: 'native-session',
        maxItems: 100, maxSerializedBytes: 64 * 1024, signal: new AbortController().signal };
      const tail = await reader.pageTranscript({ ...request, direction: 'older' });
      expect(tail).toMatchObject({ ok: true });
      if (!tail.ok || !tail.value.tailCursor) throw new Error('Expected initial native watermark');
      await appendFile(path, Array.from({ length: 48 }, (_, index) => row({ type: 'event_msg',
        timestamp: '2026-10-09T12:00:01Z', payload: { type: 'collab_agent_spawn_end',
          new_thread_id: `22222222-2222-2222-2222-${index.toString().padStart(12, '0')}` } })).join(''));
      const advanced = await reader.readAfterTranscript({ ...request, cursor: tail.value.tailCursor });
      expect(advanced).toMatchObject({ ok: true, value: { outcome: 'advanced', hasMore: false } });
      if (!advanced.ok || !advanced.value.nextCursor) throw new Error('Expected bounded semantic continuation');
      expect(advanced.value.items).toHaveLength(48);
      expect(Buffer.byteLength(JSON.stringify(advanced), 'utf8')).toBeLessThan(request.maxSerializedBytes);
      await appendFile(path, row({ type: 'response_item', timestamp: '2026-10-09T12:00:02Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'garnet after native collaboration' }] } }));
      const resumed = await reader.readAfterTranscript({ ...request, cursor: advanced.value.nextCursor });
      expect(resumed).toMatchObject({ ok: true, value: { outcome: 'advanced', hasMore: false,
        items: [{ raw: { role: 'user', content: { text: 'garnet after native collaboration' } } }] } });
      await expect(reader.readAfterTranscript({ ...request, remoteSessionId: 'other-session',
        cursor: advanced.value.nextCursor })).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(['claude', 'codex', 'pi'] as const)('indexes real %s pages incrementally and removes a disappeared transcript', async (agentId) => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-native-'));
    const db = openDeepIndexDb({ dbPath: join(dir, 'memory.sqlite') });
    try {
      db.init();
      const project = agentId === 'claude' ? join(dir, 'projects', 'project')
        : agentId === 'codex' ? join(dir, 'sessions', '2026', '10', '09') : join(dir, 'sessions', '--workspace--');
      await mkdir(project, { recursive: true });
      const path = join(project, agentId === 'codex' ? 'rollout-2026-10-09T12-00-00-native-session.jsonl' : 'native-session.jsonl');
      const row = (id: string, text: string, parentId: string | null = 'first') => JSON.stringify(agentId === 'claude'
        ? { type: 'user', uuid: id, sessionId: 'native-session', timestamp: '2026-10-09T12:00:00Z', message: { role: 'user', content: text } }
        : agentId === 'codex' ? { type: 'response_item', timestamp: '2026-10-09T12:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
        : { type: 'message', id, parentId, timestamp: '2026-10-09T12:00:00Z', message: { role: 'user', content: text } }) + '\n';
      const header = agentId === 'claude' ? '' : JSON.stringify(agentId === 'codex'
        ? { type: 'session_meta', timestamp: '2026-10-09T12:00:00Z', payload: { id: 'native-session', timestamp: '2026-10-09T12:00:00Z', cwd: '/workspace' } }
        : { type: 'session', version: 3, id: 'native-session', timestamp: '2026-10-09T12:00:00Z', cwd: '/workspace' }) + '\n';
      const history = Array.from({ length: 205 }, (_, index) => row(`history-${index}`,
        index === 0 ? 'oldest zirconium native fact' : `obsolete historical word ${index}`, index === 0 ? null : `history-${index - 1}`)).join('');
      await writeFile(path, header + history + row('first', 'quartz native conversation', 'history-204'));
      const contribution = agentId === 'claude' ? createClaudeExternalSessionsContribution({ env: {} })
        : agentId === 'codex' ? createCodexExternalSessionsContribution({ env: { CODEX_HOME: dir } })
        : createPiExternalSessionsContribution({ env: { PI_CODING_AGENT_DIR: dir } });
      const nativeSource = agentId === 'claude' ? { kind: 'claudeConfig', configDir: dir }
        : agentId === 'codex' ? { kind: 'codexHome', home: 'user' } : { kind: 'piAgentDir', agentDir: dir, sessionFile: path };
      // Process execution is the genuine boundary; local native JSONL reads
      // must not acquire any executable authority in this fixture.
      const unavailableExec = new Proxy({} as ExecService, { get(_target, property) {
        if (property === 'then') return undefined;
        throw new Error('Unexpected process boundary access');
      } });
      const bounded = createBoundedAgentExternalSessionsContribution({ contribution,
        identity: { pluginId: `fixture.${agentId}`, agentId, occurrenceId: 'current',
          contributionQualifiedId: `fixture.${agentId}/agents/${agentId}`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' } }, isCurrent: () => true,
        retirementSignal: new AbortController().signal, createInvocationExec: async () => unavailableExec });
      const native: MemoryExternalSourceReader = { agentId, sourceKey: `${agentId}-local`, source: nativeSource,
        reader: bounded };
      const source = { type: 'external_transcript' as const, agentId, sourceKey: `${agentId}-local`, nativeSessionId: 'native-session' };
      const settings = { ...normalizeMemorySettings({ enabled: true, backfillPolicy: 'all_history',
        contentPolicy: { includeReasoning: false },
        conversationSearch: { indexExternal: { enabled: true, agents: [agentId] } } }),
        coveragePolicy: { type: 'latest_messages' as const, maxSemanticMessagesPerSession: 2 } };
      const run = () => syncExternalMemoryTranscriptOnce({ source, native, db, settings, nowMs: Date.now(), signal: new AbortController().signal });
      await run();
      const search = (query: string) => db.search({ query, scope: { type: 'global' }, maxResults: 10, includeExternal: true, includeSessions: false });
      expect(search('quartz')).toHaveLength(1);
      expect(search('obsolete')).toHaveLength(1);
      expect(search('quartz')[0]).toMatchObject({ source, sourceItemId: expect.any(String) });
      const quartz = search('quartz')[0]!;
      if (!quartz.sourceItemId) throw new Error('Indexed native hit lacks source item identity');
      const window = await getMemoryWindow({ source, sourceItemId: quartz.sourceItemId,
        ...(quartz.sourceCursor ? { cursor: quartz.sourceCursor } : {}), paddingMessages: 0,
        signal: new AbortController().signal,
        contentPolicy: settings.contentPolicy,
        fetchExternalTranscriptPage: async (request, signal) => {
          const page = await bounded.pageTranscript({ source: native.source,
            remoteSessionId: request.source.nativeSessionId, direction: 'older',
            ...(request.cursor ? { cursor: request.cursor } : {}),
            maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems,
            maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes,
            signal: signal ?? new AbortController().signal });
          if (!page.ok) throw new Error(page.code);
          return page.value;
        },
      });
      expect(window.snippets).toEqual([]);
      expect(window.citations).toEqual([]);
      expect(window.externalSnippets).toHaveLength(1);
      expect(window.externalSnippets![0]).toMatchObject({ source, sourceItemId: quartz.sourceItemId,
        text: expect.stringContaining('quartz native conversation') });
      expect(window.externalSnippets![0]).not.toHaveProperty('sessionId');
      expect(window.externalSnippets![0]).not.toHaveProperty('seqFrom');
      expect(window.externalSnippets![0]).not.toHaveProperty('seqTo');
      const before = db.getExternalSourceState({ sessionId: externalMemoryStorageId(source) });
      expect(before?.cursor).toBeTruthy();
      await appendFile(path, row('second', 'garnet appended conversation'));
      await run();
      expect(search('garnet')).toHaveLength(1);
      expect(search('quartz')).toHaveLength(1);
      expect(search('obsolete')).toHaveLength(0);
      await run();
      expect(search('garnet')).toHaveLength(1);
      const fullSettings = { ...settings, coveragePolicy: { type: 'full' as const } };
      const runFull = () => syncExternalMemoryTranscriptOnce({ source, native, db, settings: fullSettings,
        nowMs: Date.now(), signal: new AbortController().signal });
      expect(await runFull()).toBe('more');
      expect(await runFull()).toBe('current');
      expect(search('zirconium')).toHaveLength(1);
      expect(search('quartz')).toHaveLength(1);
      expect(search('garnet')).toHaveLength(1);
      expect(await runFull()).toBe('current');
      expect(search('zirconium')).toHaveLength(1);
      await appendFile(path, row('third', 'topaz embedding service outage', 'second'));
      await expect(syncExternalMemoryTranscriptOnce({ source, native, db, settings: fullSettings,
        nowMs: Date.now(), signal: new AbortController().signal,
        embeddings: { providerKind: 'fixture', modelId: 'fixture' },
        embedDocuments: async () => { throw new Error('embedding service unavailable'); },
      })).resolves.toBe('current');
      expect(search('topaz')).toHaveLength(1);
      db.deleteSessionIndexData({ sessionId: externalMemoryStorageId(source) });
      const stoppedDuringEmbedding = new AbortController();
      await expect(syncExternalMemoryTranscriptOnce({ source, native, db, settings: fullSettings,
        nowMs: Date.now(), signal: stoppedDuringEmbedding.signal,
        embeddings: { providerKind: 'fixture', modelId: 'fixture' },
        embedDocuments: async () => {
          stoppedDuringEmbedding.abort(new Error('Stopped during embedding'));
          stoppedDuringEmbedding.signal.throwIfAborted();
          return [];
        },
      })).rejects.toThrow('Stopped during embedding');
      expect(search('topaz')).toHaveLength(1);
      expect(db.getExternalSourceState({ sessionId: externalMemoryStorageId(source) })).not.toBeNull();
      // Resume the preserved bounded backfill before testing tail deletion.
      // A failed historical page is not complete-inventory absence evidence.
      expect(await runFull()).toBe('current');
      await rm(path);
      await runFull();
      expect(search('garnet')).toEqual([]);
      expect(db.getExternalSourceState({ sessionId: externalMemoryStorageId(source) })).toBeNull();
      // The real readers may report source_unavailable or an expired source
      // cursor; both discard all indexed bytes and the frontier immediately.
    } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
