import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeExternalSessionsContribution } from '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/contribution';
import { createCodexExternalSessionsContribution } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution';
import { createPiExternalSessionsContribution } from '../../../../../packages/plugins/pi/src/agent/externalSessions/contribution';
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
import { searchConversations } from '../../../../../apps/ui/sources/sync/domains/search/searchConversations';
import { RPC_METHODS } from '@happier-dev/protocol';

// Only cross-device transports are replaced; ingestion, SQLite, readiness and
// the unified automatic-search decision remain real.
const transports = vi.hoisted(() => ({
  rpc: vi.fn<(request: { method: string }) => Promise<unknown>>(),
  list: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('../../../../../apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transports.rpc }));
vi.mock('../../../../../apps/ui/sources/sync/ops/machineExternalSessions', () => ({ machineExternalSessionsCandidatesList: transports.list }));

describe('external memory transcript ingestion', () => {
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
      })).rejects.toThrow('unavailable');
      expect(traversal.getIndexSources?.(db)).toEqual([{ source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local' }, state: 'error' }]);
      traversal.replace([healthy]);
      expect(traversal.getIndexSources?.(db)).toEqual([{ source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local' }, state: 'ready' }]);
      traversal.invalidate('claude', 'local');
      expect(traversal.getIndexSources?.(db)).toEqual([{ source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'local' }, state: 'indexing' }]);
      await syncExternalMemoryTranscriptsBatch({ ...operation, candidates: [healthy], onSourceResult: traversal.noteSyncResult });
      expect(traversal.getIndexSources?.(db)[0]?.state).toBe('ready');
      const pendingStates: string[] = [];
      await syncExternalMemoryTranscriptsBatch({ ...operation, candidates: [healthy], onSourceResult: (source, state) => {
        traversal.noteSyncResult(source, state);
        pendingStates.push(traversal.getIndexSources(db)[0]!.state);
      } });
      expect(pendingStates).toEqual(['indexing', 'ready']);
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
    traversal.replace(candidates);
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
      resolveBoundary: async () => ({ externalSessions: bounded, occurrenceId: 'retired', retirementSignal: retirement.signal,
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
      resolveBoundary: async () => ({ externalSessions: live, occurrenceId: 'live', retirementSignal: liveRetirement.signal,
        isCurrent: () => true }) });
    expect(available.descriptors).toHaveLength(1);
    expect(available.configuredSourceKeys.has(JSON.stringify(['claude', available.descriptors[0]?.configuredSourceKey]))).toBe(true);
    expect((await discoverMemoryExternalTranscriptSources({ agents: [], account: { connectedServicesV2: [] },
      activeServerId: 'home', activeServerDir: '/fixture/home', signal: new AbortController().signal,
      resolveBoundary: async () => null })).configuredSourceKeys.size).toBe(0);
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
