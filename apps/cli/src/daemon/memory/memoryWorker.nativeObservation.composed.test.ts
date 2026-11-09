import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

const accountingDiscovery = vi.hoisted(() => ({ openedDirectories: [] as string[], abortRead: null as (() => void) | null }));
// Count real native directory reads without replacing discovery or observation logic.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, opendir: (...args: Parameters<typeof fs.opendir>) => {
    accountingDiscovery.openedDirectories.push(String(args[0]));
    accountingDiscovery.abortRead?.();
    return fs.opendir(...args);
  } };
});

// Transform the real source graph before the per-scenario hook deadline.
// Each scenario still reloads modules after selecting its isolated Home.
await import('@/api/api');
await import('@/plugins/testkit/admittedRuntime');
await import('./testkit/startMemoryWorker');
await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');

describe('registered native transcript source observation', () => {
  let directory: string;
  let env: ReturnType<typeof createEnvKeyScope>;
  let homeHttp: FastifyInstance;
  let restoreHomeHttp: (() => void) | undefined;
  let connectedServicesV2: unknown[];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-memory-source-observation-'));
    const agentDir = join(directory, 'agent');
    env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'PI_CODING_AGENT_DIR', 'HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'GEMINI_CLI_HOME', 'QWEN_RUNTIME_DIR', 'COPILOT_HOME', 'CODEBUDDY_CONFIG_DIR', 'GROK_HOME', 'KIRO_HOME', 'KIMI_CODE_HOME', 'CODEX_HOME', 'HAPPIER_CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HAPPIER_CLAUDE_CONFIG_DIR']);
    env.patch({ HAPPIER_HOME_DIR: join(directory, 'home'), HAPPIER_SERVER_URL: 'https://home.test',
      HAPPIER_WEBAPP_URL: 'https://home.test', PI_CODING_AGENT_DIR: agentDir, HOME: directory, USERPROFILE: directory,
      XDG_DATA_HOME: join(directory, 'data'), GEMINI_CLI_HOME: directory, QWEN_RUNTIME_DIR: join(directory, '.qwen'),
      COPILOT_HOME: join(directory, '.copilot'), CODEBUDDY_CONFIG_DIR: join(directory, '.codebuddy'),
      GROK_HOME: join(directory, '.grok'), KIRO_HOME: join(directory, '.kiro'), KIMI_CODE_HOME: join(directory, '.kimi-code'),
      CODEX_HOME: join(directory, '.codex'), HAPPIER_CODEX_HOME: join(directory, '.codex'),
      CLAUDE_CONFIG_DIR: join(directory, '.claude'), HAPPIER_CLAUDE_CONFIG_DIR: join(directory, '.claude') });
    vi.resetModules();
    connectedServicesV2 = [];
    // Own the real HTTP adapter for every scenario, including top-level backfill.
    // Request/get/create clients all reach these routes; domain readers stay real.
    homeHttp = fastify({ logger: false });
    homeHttp.get('/v1/account/profile', async () => ({ id: 'account', connectedServicesV2 }));
    homeHttp.get('/v1/account/encryption/currentness', async () => ({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    }));
    homeHttp.get('/v2/sessions', async () => ({ sessions: [], nextCursor: null, hasNext: false }));
    await homeHttp.ready();
    restoreHomeHttp = installAxiosFastifyAdapter({ app: homeHttp, origin: 'https://home.test' });
    // Reset first, then load the real graph against this case's isolated Home.
    // Loading it before reset charged a second cold graph to the reader test.
    await import('@/plugins/testkit/admittedRuntime');
    await import('./testkit/startMemoryWorker');
    await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
  });
  afterEach(async () => {
    accountingDiscovery.abortRead = null;
    restoreHomeHttp?.();
    restoreHomeHttp = undefined;
    await homeHttp?.close();
    env?.restore();
    vi.resetModules();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('rediscovers only the accounting source whose topology changed', async () => {
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
    const { createMemoryExternalTranscriptObservation } = await import('./externalTranscriptObservation');
    const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
    const { normalizeMemorySettings } = await import('@happier-dev/protocol/memory/memorySettings');
    const claudeRoot = join(directory, '.claude', 'projects');
    const codexRoot = join(directory, '.codex', 'sessions');
    await mkdir(claudeRoot, { recursive: true });
    await writeFile(join(claudeRoot, 'existing.jsonl'), '{}\n');
    await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      const day = join(codexRoot, String(index));
      await mkdir(day, { recursive: true });
      await Promise.all(Array.from({ length: 16 }, (_, file) => writeFile(join(day, `${file}.jsonl`), '{}\n')));
    }));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()),
        pluginIds: ['happier.agent.claude', 'happier.agent.codex'] } });
    const topology = new Map<string, (changedPath?: string) => void>();
    const observation = createExternalSessionObservationDaemonProjection({
      publishField: async () => { throw new Error('Accounting discovery cannot create a linked Session'); },
      // The OS watcher delivers the same structural notification as a native rename.
      watchTopologyDirectory: (path, notify) => {
        topology.set(path, notify);
        return () => { if (topology.get(path) === notify) topology.delete(path); };
      },
      watchFile: () => () => {},
    });
    const sources = createMemoryExternalTranscriptObservation({ credentials: { token: 'fixture', encryption: null }, onChange() {} });
    const settings = normalizeMemorySettings({ v: 1, enabled: true,
      conversationSearch: { indexExternal: { enabled: true, agents: ['claude', 'codex'] } } });
    const signal = new AbortController().signal;
    const codexReads = () => accountingDiscovery.openedDirectories.filter(path => path === codexRoot || path.startsWith(codexRoot + sep)).length;
    sources.attach(observation);
    try {
      accountingDiscovery.openedDirectories.length = 0;
      await sources.refresh(settings, signal);
      expect(sources.takeSnapshot().sources).toHaveLength(2);
      expect(codexReads()).toBe(65);
      accountingDiscovery.openedDirectories.length = 0;
      const added = join(claudeRoot, 'added.jsonl');
      await writeFile(added, '{}\n');
      expect(topology.has(claudeRoot)).toBe(true);
      topology.get(claudeRoot)!(added);
      expect(sources.hasPendingChanges()).toBe(true);
      await sources.refresh(settings, signal);
      const snapshot = sources.takeSnapshot();
      expect(snapshot.sources).toHaveLength(2);
      expect(snapshot.changes).toEqual([expect.objectContaining({ agentId: 'claude', refreshSources: true })]);
      expect(accountingDiscovery.openedDirectories).toContain(claudeRoot);
      expect(codexReads()).toBe(0);
      // The retained source still observes its next change and gets its own fresh inventory.
      accountingDiscovery.openedDirectories.length = 0;
      const codexAdded = join(codexRoot, 'added.jsonl');
      await writeFile(codexAdded, '{}\n');
      expect(topology.has(codexRoot)).toBe(true);
      topology.get(codexRoot)!(codexAdded);
      // A failed replacement must leave unchanged source observation alive.
      const cancelledRefresh = new AbortController();
      accountingDiscovery.abortRead = () => cancelledRefresh.abort(new Error('fixture_discovery_cancelled'));
      await expect(sources.refresh(settings, cancelledRefresh.signal)).rejects.toThrow('fixture_discovery_cancelled');
      accountingDiscovery.abortRead = null;
      expect(topology.has(claudeRoot)).toBe(true);
      accountingDiscovery.openedDirectories.length = 0;
      await sources.refresh(settings, signal);
      expect(sources.takeSnapshot().changes).toEqual([expect.objectContaining({ agentId: 'codex', refreshSources: true })]);
      expect(codexReads()).toBe(65);
      expect(accountingDiscovery.openedDirectories).not.toContain(claudeRoot);
      // An explicit refresh without a source-scoped hint still discovers every selected source.
      accountingDiscovery.openedDirectories.length = 0;
      await sources.refresh(settings, signal);
      sources.takeSnapshot();
      expect(codexReads()).toBe(65);
    } finally {
      await sources.dispose();
      await observation.dispose();
      await runtime.dispose();
    }
  });
  it.each(['all_history', 'new_only'] as const)('publishes pre-opt-in Codex history, append and rewrite in both linked and user partitions with %s Happier backfill', async backfillPolicy => {
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
    const { configuration } = await import('@/configuration');
    const { resolveConnectedServiceHomeDir } = await import('@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir');
    const { CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME } = await import('@happier-dev/protocol/agents/codex/native-home-policy');
    const { createMemoryExternalTranscriptSources } = await import('./testkit/externalTranscriptSources');
    const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
    const { normalizeMemorySettings } = await import('@happier-dev/protocol/memory/memorySettings');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const { syncExternalMemoryTranscriptsBatch, externalMemoryStorageId } = await import('./externalTranscriptIndex');
    const profileId = '7e9ced1f-60ac-4618-bcf0-31adc1c2e4aa';
    const id = '11111111-1111-4111-8111-111111111111';
    const sessions = join(directory, '.codex', 'sessions');
    const day = join(sessions, '2026', '10', '22');
    await mkdir(day, { recursive: true });
    await mkdir(join(directory, '.codex', 'archived_sessions'), { recursive: true });
    const home = join(resolveConnectedServiceHomeDir({ activeServerDir: configuration.activeServerDir,
      agentId: 'codex', serviceId: 'openai-codex', profileId }), CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME);
    await mkdir(home, { recursive: true });
    await mkdir(join(home, 'archived_sessions'), { recursive: true });
    await symlink(sessions, join(home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const header = JSON.stringify({ type: 'session_meta', timestamp, payload: { id, cwd: '/fixture' } }) + '\n';
    const row = (ordinal: number, text: string) => JSON.stringify({ type: 'response_item', timestamp, payload: {
      type: 'message', role: ordinal % 2 ? 'assistant' : 'user', content: [{ type: ordinal % 2 ? 'output_text' : 'input_text',
        text: `${text} ordinal${ordinal} café 東京` }],
    } }) + '\n';
    const path = join(day, `rollout-2026-10-22T00-00-00-${id}.jsonl`);
    // The file exists before source opt-in; neither alias receives a creation event.
    await writeFile(path, header + row(0, 'quartz') + row(1, 'quartz'));
    const unreadableId = '00000000-0000-4000-8000-000000000001';
    await writeFile(join(day, `rollout-2026-10-22T00-00-00-${unreadableId}.jsonl`), Buffer.concat([
      Buffer.from(JSON.stringify({ type: 'session_meta', timestamp, payload: { id: unreadableId, cwd: '/fixture' } }) + '\n'
        + '{"type":"response_item","payload":{"type":"message","role":"user","content":"'),
      Buffer.from([0xff]), Buffer.from('"}}\n'),
    ]));
    connectedServicesV2 = [{
        serviceId: 'openai-codex', profiles: [{ profileId, status: 'connected', kind: 'oauth', providerEmail: null,
          providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null }], groups: [],
    }];
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: ['happier.agent.codex'] } });
    const observation = createExternalSessionObservationDaemonProjection({
      publishField: async () => { throw new Error('Native indexing cannot create a linked Session'); },
    });
    let refresh = true;
    let changes = 0;
    const sources = createMemoryExternalTranscriptSources({ credentials: { token: 'fixture', encryption: null },
      onChange: changed => { refresh ||= changed; changes++; } });
    const db = openDeepIndexDb({ dbPath: join(directory, 'r274.sqlite') });
    const lifetime = new AbortController();
    const settings = normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy, enabledAtMs: Date.now(),
      coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: { enabled: true, agents: ['codex'], historyDays: 1 } } });
    sources.attach(observation);
    const tick = async () => {
      if (refresh) { refresh = false; await sources.refresh(settings, lifetime.signal); }
      await sources.inventory(lifetime.signal);
      await syncExternalMemoryTranscriptsBatch({ candidates: sources.take(1), db, settings, nowMs: Date.now(),
        signal: lifetime.signal, onSourceResult: sources.noteSyncResult });
    };
    const partitions = () => db.listExternalSourceStates().filter(state => state.source.nativeSessionId === id);
    const texts = (query: string, sessionId: string) => db.search({ query, scope: { type: 'session', sessionId },
      maxResults: 10, includeExternal: true, includeSessions: false }).map(hit => hit.text);
    try {
      await tick();
      for (let turn = 1; turn < sources.getReadySourceCount(); turn++) await tick();
      expect(partitions()).toHaveLength(2);
      const ids = partitions().map(state => externalMemoryStorageId(state.source));
      for (const sessionId of ids) expect(texts('quartz', sessionId)).toHaveLength(2);
      const before = changes;
      await appendFile(path, row(2, 'garnet'));
      await vi.waitFor(() => expect(changes).toBeGreaterThan(before));
      for (let turn = 0; turn < ids.length * 2; turn++) await tick();
      for (const sessionId of ids) expect(texts('garnet', sessionId), sessionId).toHaveLength(1);
      const beforeRewrite = changes;
      const beforeBytes = await stat(path);
      await writeFile(path, header + row(0, 'zircon') + row(1, 'zircon') + row(2, 'garnet'));
      expect((await stat(path)).size).toBe(beforeBytes.size);
      await vi.waitFor(() => expect(changes).toBeGreaterThan(beforeRewrite));
      // Refresh alternates with the unreadable sibling; rewrite detection and
      // its replacement page are two turns per partition under that allowance.
      for (let turn = 0; turn < ids.length * 4; turn++) {
        await tick();
        expect(partitions(), 'a rewrite is not a source deletion').toHaveLength(2);
      }
      for (const sessionId of ids) {
        expect(texts('quartz', sessionId)).toEqual([]);
        expect(texts('zircon', sessionId)).toHaveLength(2);
        expect(texts('garnet', sessionId)).toHaveLength(1);
      }
      const beforeTopology = changes;
      const siblingId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      await writeFile(join(day, `rollout-2026-10-22T00-00-00-${siblingId}.jsonl`),
        JSON.stringify({ type: 'session_meta', timestamp, payload: { id: siblingId, cwd: '/fixture' } }) + '\n' + row(0, 'tourmaline'));
      await vi.waitFor(() => expect(changes).toBeGreaterThan(beforeTopology));
      await tick();
      const beforeSecondAppend = changes;
      await appendFile(path, row(3, 'citrine'));
      await vi.waitFor(() => expect(changes).toBeGreaterThan(beforeSecondAppend));
      for (let turn = 0; turn < sources.getReadySourceCount() * 2; turn++) await tick();
      for (const sessionId of ids) {
        expect(texts('citrine', sessionId)).toHaveLength(1);
        expect(texts('ordinal', sessionId).map(text => Number(/ordinal(\d+)/.exec(text)?.[1])).sort()).toEqual([0, 1, 2, 3]);
      }
    } finally {
      lifetime.abort();
      await sources.dispose();
      await observation.dispose();
      await runtime.dispose();
      db.close();
    }
  });
  it('discovers a real Codex sibling during multi-page backfill through native directory delivery', async () => {
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
    const { createMemoryExternalTranscriptSources } = await import('./testkit/externalTranscriptSources');
    const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
    const { normalizeMemorySettings } = await import('@happier-dev/protocol/memory/memorySettings');
    const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
    const { syncExternalMemoryTranscriptsBatch } = await import('./externalTranscriptIndex');
    const now = new Date().toISOString();
    const day = join(directory, '.codex', 'sessions', '2026', '10', '22');
    await mkdir(day, { recursive: true });
    const put = async (id: string, count: number, text: string) => {
      await writeFile(join(day, `rollout-2026-10-22T00-00-00-${id}.jsonl`),
        JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id, cwd: '/fixture' } }) + '\n'
        + Array.from({ length: count }, (_, ordinal) => JSON.stringify({ type: 'response_item', timestamp: now, payload: {
          type: 'message', role: 'user', content: [{ type: 'input_text', text: `${text} ordinal${ordinal} ${'coastal walk '.repeat(600)}` }],
        } }) + '\n').join(''));
    };
    const main = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
    await put(main, 200, 'r261main');
    await Promise.all(Array.from({ length: 100 }, (_, index) => put(
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 1, 'r261backlog')));
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: ['happier.agent.codex'] } });
    const observation = createExternalSessionObservationDaemonProjection({
      publishField: async () => { throw new Error('Native indexing cannot create a linked Session'); },
    });
    let refresh = true;
    let changes = 0;
    const sources = createMemoryExternalTranscriptSources({ credentials: { token: 'fixture', encryption: null },
      onChange: changed => { refresh ||= changed; changes++; } });
    const db = openDeepIndexDb({ dbPath: join(directory, 'r261.sqlite') });
    const lifetime = new AbortController();
    const settings = normalizeMemorySettings({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
      coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: { enabled: true, agents: ['codex'], historyDays: 1 } } });
    sources.attach(observation);
    const tick = async () => {
      if (refresh) { refresh = false; await sources.refresh(settings, lifetime.signal); }
      await sources.inventory(lifetime.signal);
      await syncExternalMemoryTranscriptsBatch({ candidates: sources.take(1), db, settings, nowMs: Date.now(),
        signal: lifetime.signal, onSourceResult: sources.noteSyncResult });
    };
    const search = (query: string) => db.search({ query, scope: { type: 'global' }, maxResults: 201,
      includeExternal: true, includeSessions: false });
    try {
      await sources.refresh(settings, lifetime.signal);
      refresh = false;
      let mainCandidate: ReturnType<typeof sources.take>[number] | undefined;
      let inventory;
      do {
        inventory = await sources.inventory(lifetime.signal);
        expect(inventory).not.toBeNull();
        mainCandidate ??= sources.take(sources.getReadySourceCount()).find(candidate => candidate.source.nativeSessionId === main);
        expect(sources.getIndexSources(db).some(source => source.state === 'error')).toBe(false);
      } while (!inventory?.completeSources.size);
      expect(mainCandidate, JSON.stringify({ sources: sources.getIndexSources(db), count: sources.getReadySourceCount() })).toBeDefined();
      await syncExternalMemoryTranscriptsBatch({ candidates: [mainCandidate!], db, settings, nowMs: Date.now(),
        signal: lifetime.signal, onSourceResult: sources.noteSyncResult });
      expect(search('r261main').length).toBeGreaterThan(0);
      expect(search('r261main').length).toBeLessThan(200);
      const before = changes;
      const started = performance.now();
      await put('ffffffff-ffff-4fff-8fff-ffffffffffff', 2, 'r261sibling');
      await vi.waitFor(() => expect(changes).toBeGreaterThan(before));
      for (let turn = 0; turn < 4 && search('r261sibling').length === 0; turn++) await tick();
      console.info('R261_NATIVE_SIBLING', JSON.stringify({ changes: changes - before,
        hits: search('r261sibling').length, elapsedMs: performance.now() - started }));
      expect(search('r261sibling')).toHaveLength(2);
      expect(sources.getIndexSources(db).some(source => source.state === 'indexing')).toBe(true);
      // A topology refresh replaces the accounting demand but keeps admitted
      // transcript work. Its next read must consume the new demand's hints.
      await sources.refresh(settings, lifetime.signal);
      mainCandidate!.native.readObservation?.();
      expect(mainCandidate!.native.readObservation?.()?.changedFiles).toEqual([]);
      const changedBefore = changes;
      const mainPath = join(day, `rollout-2026-10-22T00-00-00-${main}.jsonl`);
      await appendFile(mainPath, JSON.stringify({ type: 'response_item', timestamp: now, payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'r268 observed append' }],
      } }) + '\n');
      await vi.waitFor(() => expect(changes).toBeGreaterThan(changedBefore));
      // The reader consumes daemon watch facts at the serialized snapshot
      // boundary; OS notification alone does not mutate a child-owned reader.
      await sources.inventory(lifetime.signal);
      expect(mainCandidate!.native.readObservation?.()?.changedFiles).toContain(mainPath);
      expect(mainCandidate!.native.readObservation?.()?.changedFiles).toEqual([]);
    } finally {
      lifetime.abort();
      await sources.dispose();
      await observation.dispose();
      await runtime.dispose();
      db.close();
    }
  });
  describe.each([
    { agentId: 'codex', pluginId: 'happier.agent.codex' },
    { agentId: 'pi', pluginId: 'happier.agent.pi' },
    { agentId: 'ohMyPi', pluginId: 'happier.agent.ohmypi' },
    { agentId: 'antigravity', pluginId: 'happier.agent.antigravity' },
    { agentId: 'kilo', pluginId: 'happier.agent.kilo' },
    { agentId: 'gemini', pluginId: 'happier.agent.gemini' },
    { agentId: 'qwen', pluginId: 'happier.agent.qwen' },
    { agentId: 'fx', pluginId: 'happier.agent.fx' },
    { agentId: 'auggie', pluginId: 'happier.agent.auggie' },
    { agentId: 'copilot', pluginId: 'happier.agent.copilot' },
    { agentId: 'droid', pluginId: 'happier.agent.droid' },
    { agentId: 'codebuddy', pluginId: 'happier.agent.codebuddy' },
    { agentId: 'cursor', pluginId: 'happier.agent.cursor' },
    { agentId: 'grok', pluginId: 'happier.agent.grok' },
    { agentId: 'kiro', pluginId: 'happier.agent.kiro' },
    { agentId: 'kimi', pluginId: 'happier.agent.kimi' },
    { agentId: 'devin', pluginId: 'happier.agent.devin' },
  ])('$agentId native source', ({ agentId, pluginId }) => {
    let runScenario: (() => Promise<void>) | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    let codexCorpus: Readonly<{ prepare(): Promise<void>; demand(): Promise<void>; appendSibling(): Promise<void> }> | undefined;
    beforeEach(async () => {
      const agentDir = join(directory, 'agent');
      // The outer fixture owns Home HTTP; only OS watch delivery is controlled here.
      let runtime: Awaited<ReturnType<typeof import('@/plugins/testkit/admittedRuntime').createAdmittedPluginRuntimeFixture>> | undefined;
      let worker: Awaited<ReturnType<typeof import('./memoryWorker').startMemoryWorker>> | undefined;
      let observation: ReturnType<typeof import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection').createExternalSessionObservationDaemonProjection> | undefined;
      const fileChanges = new Map<string, (path: string) => void>();
      const topologyChanges = new Map<string, (path?: string) => void>();
      let devinFixture: ReturnType<typeof import('../../../../../packages/plugins/devin/src/agent/externalSessions/__fixtures__/nativeSession.test-support').createDevinNativeFixture> | undefined;
      cleanup = async () => {
        await worker?.stop();
        await observation?.dispose();
        await runtime?.dispose();
        devinFixture?.close();
      };
      const isCodex = agentId === 'codex';
      const isAntigravity = agentId === 'antigravity';
      const isKilo = agentId === 'kilo';
      const isGemini = agentId === 'gemini';
      const isQwen = agentId === 'qwen';
      const isFx = agentId === 'fx';
      const isAuggie = agentId === 'auggie';
      const isCopilot = agentId === 'copilot';
      const isDroid = agentId === 'droid';
      const isCodeBuddy = agentId === 'codebuddy';
      const isCursor = agentId === 'cursor';
      const isGrok = agentId === 'grok';
      const isKiro = agentId === 'kiro';
      const isKimi = agentId === 'kimi';
      const isDevin = agentId === 'devin';
      const kimiFixture = isKimi ? await import('../../../../../packages/plugins/kimi/src/agent/externalSessions/__fixtures__/kimiCode.test-support') : null;
      const nativeSessionId = '8b6e1959-546e-4a3b-a6c2-4c1d6109f210';
      const kiloRoot = join(directory, 'data', 'kilo', 'storage');
      const transcriptPath = isCodex ? join(directory, '.codex', 'sessions', `rollout-2026-10-20T10-00-00-${nativeSessionId}.jsonl`)
        : isDevin ? join(directory, 'data', 'devin', 'cli', 'sessions.db')
        : isKimi ? join(directory, '.kimi-code', 'sessions', 'wd_fixture_123', 'session_fixture', 'agents', 'main', 'wire.jsonl')
        : isCursor ? join(directory, '.cursor', 'projects', 'repo', 'agent-transcripts', `${nativeSessionId}.jsonl`)
        : isGrok ? join(directory, '.grok', 'sessions', 'hashed-workspace', nativeSessionId, 'chat_history.jsonl')
        : isKiro ? join(directory, '.kiro', 'sessions', 'cli', `${nativeSessionId}.jsonl`)
        : isCopilot ? join(directory, '.copilot', 'session-state', 'native', 'events.jsonl')
        : isDroid ? join(directory, '.factory', 'sessions', '-repo', 'native.jsonl')
        : isCodeBuddy ? join(directory, '.codebuddy', 'projects', '-repo', 'native.jsonl')
        : isAuggie ? join(directory, '.augment', 'sessions', 'native-session.json')
        : isFx ? join(directory, '.fx', 'sessions', 'native', 'events.jsonl')
        : isKilo ? join(kiloRoot, 'session', 'project', 'ses_fixture.json') : isAntigravity
        ? join(directory, '.gemini', 'antigravity-cli', 'brain', 'native', '.system_generated', 'logs', 'transcript_full.jsonl')
        : isGemini ? join(directory, '.gemini', 'tmp', 'project', 'chats', 'session-native-8b6e1959.jsonl')
        : isQwen ? join(directory, '.qwen', 'projects', '-repo', 'chats', `${nativeSessionId}.jsonl`)
        : join(agentDir, 'sessions', '-repo', '2026-10-20T10-00-00-000Z_native.jsonl');
      await mkdir(dirname(transcriptPath), { recursive: true });
      const fxResultName = 'result-read_file-1111111111111111-2222222222222222.txt';
      const fxResultPath = join(dirname(transcriptPath), 'tool-results', fxResultName);
      if (isFx) {
        await mkdir(dirname(fxResultPath), { recursive: true });
        await writeFile(fxResultPath, 'olivine native output');
      }
      const timestamp = new Date().toISOString();
      const row = (id: string, parentId: string | null, text: string) => isCodex
        ? JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text }] } }) + '\n'
        : kimiFixture ? kimiFixture.kimiWire([kimiFixture.kimiUser(text)]) : isFx
        ? [
          { schema_version: 3, seq: id === 'first' ? 1 : 5, timestamp_ms: Date.now(), event: { user: { text, images: [] } } },
          ...(id === 'first' ? [
            { schema_version: 3, seq: 2, timestamp_ms: Date.now(), event: { tool_call: { call_id: 'call-1', tool_name: 'read_file', arguments_json: '{}' } } },
            { schema_version: 3, seq: 3, timestamp_ms: Date.now(), event: { tool_result: { call_id: 'call-1', tool_name: 'read_file',
              status: 'success', artifact_ref: fxResultName, stored_bytes: 21, completeness: 'complete' } } },
          ] : []),
          { schema_version: 3, seq: id === 'first' ? 4 : 6, timestamp_ms: Date.now(), event: { turn_completed: { files: [], turn_summary: null } } },
        ].map(value => JSON.stringify(value)).join('\n') + '\n'
        : JSON.stringify(isAntigravity
        ? { id, type: 'USER_INPUT', text }
        : isCursor ? { role: 'user', message: { content: [{ type: 'text', text }] } }
        : isGrok ? { type: 'user', content: [{ type: 'text', text }], timestamp }
        : isKiro ? { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: text }], meta: { timestamp: Date.now() / 1000 } } }
        : isCopilot ? { id, parentId, type: 'user.message', timestamp, data: { content: text } }
        : isCodeBuddy ? { id, parentId, type: 'message', role: 'user', content: [{ type: 'input_text', text }], timestamp, sessionId: 'native' }
        : isGemini ? { id, type: 'user', timestamp, content: text }
        : isQwen ? { uuid: id, parentUuid: parentId, sessionId: nativeSessionId, timestamp, version: '0.25.3',
          type: 'user', cwd: '/repo', message: { role: 'user', parts: [{ text }] } }
        : { type: 'message', id, parentId, timestamp, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
      const header = isCodex ? JSON.stringify({ type: 'session_meta', timestamp, payload: { id: nativeSessionId,
        timestamp, cwd: '/repo', source: 'cli', originator: 'codex_cli_rs', cli_version: '0.162.1' } }) + '\n'
        : kimiFixture ? kimiFixture.kimiWire([kimiFixture.kimiMetadata]) : isCopilot ? JSON.stringify({ id: 'start', type: 'session.start', timestamp, data: { sessionId: 'native', version: 1,
        producer: 'copilot-agent', copilotVersion: '1.0.100', startTime: timestamp, context: { cwd: '/repo' } } }) + '\n'
        : isDroid ? JSON.stringify({ type: 'session_start', version: 2, id: 'native', cwd: '/repo' }) + '\n'
        : isGemini ? JSON.stringify({ sessionId: nativeSessionId, projectHash: 'project', startTime: timestamp, lastUpdated: timestamp }) + '\n'
        : isAntigravity || isQwen || isFx || isCodeBuddy || isCursor || isGrok || isKiro ? '' : JSON.stringify({ type: 'session', version: 3, id: 'native', timestamp, cwd: '/repo' }) + '\n';
      // Sanitised paired-store vectors from upstream a18b44bfc0; producing CLI
      // versions are unknown, as recorded beside the plugin-owned fixtures.
      const sidecarPath = isKimi ? join(directory, '.kimi-code', 'sessions', 'wd_fixture_123', 'session_fixture', 'state.json')
        : isCursor ? join(directory, '.cursor', 'chats', 'workspace-hash', nativeSessionId, 'meta.json')
        : isGrok ? join(dirname(transcriptPath), 'summary.json')
        : isKiro ? transcriptPath.slice(0, -1) : null;
      if (sidecarPath && !isKimi) {
        await mkdir(dirname(sidecarPath), { recursive: true });
        await writeFile(sidecarPath, JSON.stringify(isCursor
          ? { schemaVersion: 1, title: 'Ordinary title', cwd: '/repo', createdAtMs: Date.now(), updatedAtMs: Date.now(), hasConversation: true }
          : isGrok ? { info: { id: nativeSessionId, cwd: '/repo' }, generated_title: 'Ordinary title', created_at: timestamp, updated_at: timestamp }
          : { session_id: nativeSessionId, cwd: '/repo', title: 'Ordinary title', created_at: timestamp, updated_at: timestamp }));
      }
      if (isFx) {
        // Vendor-source schema-4 metadata; body frames use conversation schema 3.
        await writeFile(join(dirname(transcriptPath), 'session.json'), JSON.stringify({ schema_version: 4,
          id: 'native', origin_workspace_root: '/repo', workspace_root: '/repo', created_at_ms: Date.now(), updated_at_ms: Date.now(),
          conversation_language: 'en', provider: 'openai', model: 'fixture-model', effort: 'medium', fast_mode: false,
          title: 'ordinary title', subagent_child: false }));
      }
      const putKilo = async (path: string, value: unknown) => {
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value));
      };
      const writeAuggie = async (texts: readonly string[]) => {
        const { buildAuggieNativeSession } = await import('../../../../../packages/plugins/auggie/src/agent/surfaces/sessions/external/__fixtures__/nativeSession.test-support');
        await writeFile(transcriptPath, JSON.stringify(buildAuggieNativeSession(texts)));
      };
      if (isDevin) {
        const { createDevinNativeFixture } = await import('../../../../../packages/plugins/devin/src/agent/externalSessions/__fixtures__/nativeSession.test-support');
        devinFixture = createDevinNativeFixture(dirname(transcriptPath), ['quartz initial native message']);
      } else if (kimiFixture) {
        await kimiFixture.writeKimiFixture(join(directory, '.kimi-code'));
        await appendFile(transcriptPath, row('first', null, 'quartz initial native message'));
      } else if (isAuggie) {
        await writeAuggie(['quartz initial native message']);
      } else if (isKilo) {
        // Pinned vendor schema vector, shared with the real plugin owner suite.
        const fixture: { session: Record<string, unknown>; messages: { id: string; sessionID: string }[];
          parts: { id: string; messageID: string }[] } = JSON.parse(await readFile(new URL(
          '../../../../../packages/plugins/kilo/src/agent/externalSessions/__fixtures__/kilo-json-1.0.25.json', import.meta.url), 'utf8'));
        await putKilo(transcriptPath, { ...fixture.session, time: { created: Date.now(), updated: Date.now() } });
        for (const message of fixture.messages) await putKilo(join(kiloRoot, 'message', message.sessionID, `${message.id}.json`), message);
        for (const part of fixture.parts) await putKilo(join(kiloRoot, 'part', part.messageID, `${part.id}.json`), part);
      } else {
        await writeFile(transcriptPath, header + row('first', null, 'quartz initial native message'));
      }
      if (isGemini) {
        const { gemini } = await import('../../../../../packages/plugins/gemini/src/agent/surfaces/sessions/external/__fixtures__/gemini064');
        await appendFile(transcriptPath, JSON.stringify({ ...gemini('native-tools', ''), toolCalls: [{
          id: 'call', name: 'shell', args: { command: 'topaz hidden tool input' }, status: 'success', timestamp,
          result: 'citrine native tool output',
        }] }) + '\n');
      }
      if (isQwen) {
        const { record, jsonl } = await import('../../../../../packages/plugins/qwen/src/agent/externalSessions/__fixtures__/qwen0253');
        await appendFile(transcriptPath, jsonl([
          record('native-tool-call', 'first', 'assistant', { sessionId: nativeSessionId,
            message: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'shell', args: { command: 'topaz hidden tool input' } } }] } }),
          record('native-tool-result', 'native-tool-call', 'tool_result', { sessionId: nativeSessionId,
            message: { role: 'user', parts: [{ functionResponse: { id: 'call', name: 'shell', response: { output: 'citrine native tool output' } } }] } }),
        ]));
      }
      const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
      const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
      const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
      const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
      let contributions = resolveBuiltInContributions();
      if (isDevin || isKimi || isKilo || isFx || isAuggie || isCopilot || isDroid || isCodeBuddy || isCursor || isGrok || isKiro || isGemini || isQwen) {
        // Consume the actual authored manifest through the canonical projector.
        // Program integration owns the once-per-batch generated publication.
        const { PLUGIN_MANIFEST } = isDevin ? await import('@happier-dev/plugins-devin/manifest')
          : isKimi ? await import('@happier-dev/plugins-kimi/manifest')
          : isGemini ? await import('@happier-dev/plugins-gemini/manifest')
          : isQwen ? await import('@happier-dev/plugins-qwen/manifest')
          : isCursor ? await import('@happier-dev/plugins-cursor/manifest')
          : isGrok ? await import('@happier-dev/plugins-grok/manifest')
          : isKiro ? await import('@happier-dev/plugins-kiro/manifest')
          : isCopilot ? await import('@happier-dev/plugins-copilot/manifest')
          : isDroid ? await import('@happier-dev/plugins-droid/manifest')
          : isCodeBuddy ? await import('@happier-dev/plugins-codebuddy/manifest')
          : isAuggie ? await import('@happier-dev/plugins-auggie/manifest')
          : isFx ? await import('@happier-dev/plugins-fx/manifest') : await import('@happier-dev/plugins-kilo/manifest');
        const { loadBundledPluginLocatorResult } = await import('@/plugins/projection/registry/builtIn/locators');
        const { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } = await import('@/plugins/projection/registry/sources/generatedBundledPluginManifests');
        const { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } = await import('@/plugins/projection/registry/sources/generatedBundledPlugins');
        const { projectLoadedPluginContributes } = await import('@/plugins/projection/registry/fullProjection');
        const { projectBuiltInAgents } = await import('@/plugins/projection/registry/builtIn/agents');
        const projected = projectLoadedPluginContributes({ provenance: 'first_party', loadResult: {
          loadedPlugins: loadBundledPluginLocatorResult(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator =>
            locator.pluginId === pluginId ? { ...locator, manifest: PLUGIN_MANIFEST } : locator)).loadedPlugins,
          diagnosticsByPluginId: {},
        } });
        contributions = { ...contributions, ...projected, agents: projectBuiltInAgents({
          manifestAgents: projected.agents ?? [], registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS,
        }), providers: projected.providers ?? [] };
      }
      runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { contributes: createResolvedContributionRegistry(contributions), pluginIds: [pluginId] } });
      expect(runtime.registry.agentRuntimesByAgentId.get(agentId)?.externalSessions,
        JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId[pluginId] ?? [])).toBeTruthy();
      if (isGemini || isQwen) {
        const reader = runtime.registry.agentRuntimesByAgentId.get(agentId)!.externalSessions!;
        const { EXTERNAL_SESSIONS_INVOCATION_POLICY } = await import('@/session/external/agentExternalSessionsInvocation');
        const source = { kind: isGemini ? 'geminiConfigDir' : 'qwenRuntimeDir' };
        const candidates = await reader.listCandidates({ source, ...EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates,
          signal: new AbortController().signal });
        if (!candidates.ok) throw new Error(`Registered ${agentId} native inventory failed: ${JSON.stringify(candidates)}`);
        const initialPage = await reader.pageTranscript({ source, remoteSessionId: nativeSessionId, direction: 'older',
          ...EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript, signal: new AbortController().signal });
        if (!initialPage.ok) throw new Error(`Registered ${agentId} native page failed: ${JSON.stringify(initialPage)}`);
      }
      if (isKimi) {
        // An earlier browse consumer has its own tail. Enabling Memory later
        // must still ingest both that prefix and the subsequently appended row.
        const reader = runtime.registry.agentRuntimesByAgentId.get(agentId)!.externalSessions!;
        const source = { kind: 'kimiCodeHome' };
        const bounds = { source, signal: new AbortController().signal, maxItems: 1, maxSerializedBytes: 100_000 };
        const listed = await reader.listCandidates(bounds);
        if (!listed.ok) throw new Error(`Kimi warm discovery: ${listed.code}: ${listed.message ?? ''}`);
        expect(listed).toMatchObject({ ok: true, value: { candidates: [expect.anything()] } });
        expect(await reader.pageTranscript({ ...bounds, remoteSessionId: 'session_fixture', direction: 'older' }))
          .toMatchObject({ ok: true, value: { tailCursor: expect.any(String) } });
        await appendFile(transcriptPath, row('warm', 'first', 'jade before Memory enable'));
      }
      const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
      observation = createExternalSessionObservationDaemonProjection({
        publishField: async () => { throw new Error('Transcript indexing must not fabricate a linked Session'); },
        watchFile: (path, onChange) => { fileChanges.set(path, onChange); return () => { fileChanges.delete(path); }; },
        watchTopologyDirectory: (path, onChange) => { topologyChanges.set(path, onChange); return () => { topologyChanges.delete(path); }; },
      });
      const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
      await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
        // This journey exercises immediate recovery from a deliberately missing
        // store. The separate batch keeper verifies the real backoff boundary.
        deep: { failureBackoffBaseMs: 0, failureBackoffMaxMs: 0 },
        coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: {
          enabled: true, agents: [agentId], historyDays: isCodex ? 1 : null, includeToolOutput: isFx,
        } } });
      const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
      worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine' });
      const startedWorker = worker;
      const sourceObservation = observation;
      if (isCodex) {
        const { EXTERNAL_SESSIONS_INVOCATION_POLICY } = await import('@/session/external/agentExternalSessionsInvocation');
        const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
        const backlogCount = EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems * 6;
        const putRollout = async (id: string, day: string, text: string) => {
          const path = join(dirname(transcriptPath), `rollout-${day}T10-00-00-${id}.jsonl`);
          await writeFile(path, JSON.stringify({ type: 'session_meta', timestamp, payload: { id,
            timestamp, cwd: '/repo', source: 'cli', originator: 'codex_cli_rs', cli_version: '0.162.1' } }) + '\n'
            + row('first', null, text));
          return path;
        };
        const readIndex = <T>(read: (db: ReturnType<typeof openDeepIndexDb>) => T) => {
          const db = openDeepIndexDb({ dbPath: startedWorker.getDeepDbPath()! });
          try { return read(db); } finally { db.close(); }
        };
        const assertReady = () => expect(startedWorker.getIndexSources!()
          .find(item => item.source.type === 'external_transcript')?.state).toBe('ready');
        codexCorpus = {
          async prepare() {
            await rm(transcriptPath);
            await Promise.all(Array.from({ length: backlogCount }, (_, index) => putRollout(
              `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, '2026-10-20', 'corundum initial inventory')));
            startedWorker.attachExternalObservation!(sourceObservation);
          },
          async demand() {
            await startedWorker.ensureUpToDate();
            expect(readIndex(db => db.listExternalSourceStates().length)).toBe(backlogCount);
            assertReady();
          },
          async appendSibling() {
            const sibling = await putRollout('ffffffff-ffff-4fff-8fff-ffffffffffff', '2026-10-21', 'tourmaline fresh sibling');
            let parent = dirname(sibling);
            while (!topologyChanges.has(parent)) {
              const next = dirname(parent);
              if (next === parent) throw new Error('Codex fixture has no covering topology observer');
              parent = next;
            }
            topologyChanges.get(parent)!(sibling);
            await startedWorker.ensureUpToDate();
            expect(readIndex(db => db.search({ query: 'tourmaline', scope: { type: 'global' },
              maxResults: 10, includeExternal: true, includeSessions: false }))).toHaveLength(1);
            expect(readIndex(db => db.listExternalSourceStates().length)).toBe(backlogCount + 1);
            assertReady();
          },
        };
      }
      runScenario = async () => {
        const worker = startedWorker;
        worker.attachExternalObservation!(sourceObservation);
        await worker.ensureUpToDate();
        const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
        const search = (query: string) => {
          const db = openDeepIndexDb({ dbPath: worker!.getDeepDbPath()! });
          try { return db.search({ query, scope: { type: 'global' }, maxResults: 10, includeExternal: true, includeSessions: false }); }
          finally { db.close(); }
        };
        const readFrontier = () => {
          const db = openDeepIndexDb({ dbPath: worker!.getDeepDbPath()! });
          try { return db.listExternalSourceStates()[0]!; }
          finally { db.close(); }
        };
        expect(search('quartz'), JSON.stringify({ sources: worker.getIndexSources(), status: worker.getWorkerStatus(),
          observedTranscript: fileChanges.has(transcriptPath) })).toHaveLength(1);
        if (isCodex) expect(worker.getIndexSources!()).toContainEqual({
          source: { type: 'external_transcript', agentId: 'codex', sourceKey: 'codexHome:user:::' }, state: 'ready',
        });
        expect(search('garnet')).toEqual([]);
        if (isGemini || isQwen) {
          expect(search('topaz')).toEqual([]);
          expect(search('citrine')).toEqual([]);
        }
        const initialFrontier = readFrontier();
        // A retained tail makes the next tick consume readAfterTranscript rather
        // than rebuilding the initial page; this is the production frontier.
        expect(JSON.parse(initialFrontier.cursor!)).toMatchObject({ type: 'tail', cursor: expect.any(String) });
        // A successful initial inventory alone does not establish observation.
        expect(fileChanges.has(transcriptPath)).toBe(true);
        if (sidecarPath) expect(fileChanges.has(sidecarPath)).toBe(true);
        const notifyFile = fileChanges.get(transcriptPath)!;
        if (isDevin) {
          expect(fileChanges.has(transcriptPath + '-wal')).toBe(true);
          await rename(transcriptPath, transcriptPath + '.retained');
          notifyFile(transcriptPath);
          await expect(worker.ensureUpToDate()).resolves.toBeUndefined();
          expect(worker.getIndexSources()).toContainEqual(expect.objectContaining({
            source: expect.objectContaining({ agentId }), state: 'error', errorCode: expect.any(String),
          }));
          expect(search('quartz')).toHaveLength(1);
          await rename(transcriptPath + '.retained', transcriptPath);
        }
        if (isAuggie) {
          // An interrupted native snapshot is unavailable, not authoritative
          // disappearance. Retain the prior projection until a valid read.
          await writeFile(transcriptPath, '{');
          notifyFile(transcriptPath);
          await expect(worker.ensureUpToDate()).resolves.toBeUndefined();
          expect(worker.getIndexSources()).toContainEqual(expect.objectContaining({
            source: expect.objectContaining({ agentId }), state: 'error', errorCode: expect.any(String),
          }));
          expect(search('quartz')).toHaveLength(1);
        }
        const appendedPath = isKilo ? join(kiloRoot, 'part', 'msg_02', 'prt_05.json') : transcriptPath;
        if (isDevin) {
          devinFixture!.append('garnet appended native message');
          fileChanges.get(transcriptPath + '-wal')!(transcriptPath + '-wal');
        } else if (isAuggie) {
          await writeAuggie(['quartz initial native message', 'garnet appended native message']);
          notifyFile(transcriptPath);
        } else if (isKilo) {
          await putKilo(appendedPath, { id: 'prt_05', sessionID: 'ses_fixture', messageID: 'msg_02', type: 'text', text: 'garnet appended native message' });
          expect(topologyChanges.has(kiloRoot)).toBe(true);
          topologyChanges.get(kiloRoot)!(appendedPath);
        } else {
          await appendFile(transcriptPath, row('second', isQwen ? 'native-tool-result' : 'first', 'garnet appended native message'));
          notifyFile(transcriptPath);
        }
        await worker.ensureUpToDate();
        expect(search('garnet')).toHaveLength(1);
        expect(search('quartz')).toHaveLength(1);
        if (isKimi) expect(search('jade')).toHaveLength(1);
        expect(readFrontier().nextOrdinal).toBeGreaterThan(initialFrontier.nextOrdinal);
        if (isFx) {
          // A referenced result can change without any event-log append. The
          // incumbent observer invalidates the same reader's prefix witness.
          expect(search('olivine')).toHaveLength(1);
          expect(fileChanges.has(fxResultPath)).toBe(true);
          await writeFile(fxResultPath, 'citrine native output');
          fileChanges.get(fxResultPath)!(fxResultPath);
          await worker.ensureUpToDate();
          await worker.ensureUpToDate();
          expect(search('olivine')).toEqual([]);
          expect(search('citrine')).toHaveLength(1);
          expect(search('quartz')).toHaveLength(1);
          expect(search('garnet')).toHaveLength(1);
        }
        if (kimiFixture) {
          // An unavailable wire is not proof the native Session was deleted.
          const savedWire = await readFile(transcriptPath);
          await rm(transcriptPath);
          topologyChanges.get(join(directory, '.kimi-code'))!();
          await expect(worker.ensureUpToDate()).resolves.toBeUndefined();
          expect(worker.getIndexSources()).toContainEqual(expect.objectContaining({
            source: expect.objectContaining({ agentId }), state: 'error', errorCode: expect.any(String),
          }));
          expect(search('quartz')).toHaveLength(1);
          expect(search('garnet')).toHaveLength(1);
          await writeFile(transcriptPath, savedWire);
          topologyChanges.get(join(directory, '.kimi-code'))!();
          await worker.ensureUpToDate();
          await worker.ensureUpToDate();
          await appendFile(transcriptPath, kimiFixture.kimiWire([{ type: 'context.undo', count: 1 }]));
          fileChanges.get(transcriptPath)!(transcriptPath);
          await worker.ensureUpToDate();
          await worker.ensureUpToDate();
          expect(search('garnet')).toEqual([]);
          expect(search('quartz')).toHaveLength(1);
          expect(search('jade')).toHaveLength(1);
        }
        if (isKilo) {
          // A settled part can change without a message/session timestamp update.
          await putKilo(appendedPath, { id: 'prt_05', sessionID: 'ses_fixture', messageID: 'msg_02', type: 'text', text: 'opal replacement native message' });
          expect(fileChanges.has(appendedPath)).toBe(true);
          fileChanges.get(appendedPath)!(appendedPath);
          await worker.ensureUpToDate();
          expect(search('garnet')).toEqual([]);
          // Replacement retires the old projection; the next worker turn
          // reads the current source again through the initial page boundary.
          await worker.ensureUpToDate();
          expect(search('opal')).toHaveLength(1);
          await putKilo(transcriptPath, { id: 'ses_fixture', projectID: 'project', directory: '/repo', title: 'Ordinary title',
            version: '1.0.25', time: { created: Date.now(), updated: Date.now() }, revert: { messageID: 'msg_02' } });
          fileChanges.get(transcriptPath)!(transcriptPath);
          await worker.ensureUpToDate();
          expect(search('opal')).toEqual([]);
          await worker.ensureUpToDate();
          expect(search('quartz')).toHaveLength(1);
        }
        if (isDevin || isKimi || isGemini || isQwen || isFx || isAuggie || isCopilot || isDroid || isCodeBuddy || isCursor || isGrok || isKiro) {
          if (isDevin) {
            devinFixture!.db.prepare('UPDATE message_nodes SET chat_message=? WHERE node_id=1').run(JSON.stringify({
              role: 'user', message_id: 'message-1', content: 'amethyst replacement message',
            }));
            devinFixture!.db.prepare('UPDATE sessions SET main_chain_id=1').run();
          } else if (isAuggie) await writeAuggie(['amethyst replacement message']);
          else await writeFile(transcriptPath, header + row(isFx ? 'first' : 'replacement', null, 'amethyst replacement message'));
          fileChanges.get(transcriptPath)!(transcriptPath);
          await worker.ensureUpToDate();
          await worker.ensureUpToDate();
          expect(search('quartz')).toEqual([]);
          expect(search('garnet')).toEqual([]);
          expect(search('amethyst')).toHaveLength(1);
          if (sidecarPath) {
            const metadata: Record<string, unknown> = JSON.parse(await readFile(sidecarPath, 'utf8'));
            await writeFile(sidecarPath, JSON.stringify({ ...metadata, ...(isGrok ? { generated_title: 'Renamed title' } : { title: 'Renamed title' }) }));
            fileChanges.get(sidecarPath)!(sidecarPath);
            await worker.ensureUpToDate();
            expect(search('amethyst')).toHaveLength(1);
          }
        }
        if (isDevin) {
          // An authoritative deletion inside a readable shared DB retires rows;
          // losing the whole DB above must retain them.
          devinFixture!.db.prepare('DELETE FROM message_nodes').run();
          devinFixture!.db.prepare('DELETE FROM sessions').run();
        } else if (isKimi) await rm(dirname(sidecarPath!), { recursive: true });
        else await rm(transcriptPath);
        fileChanges.get(transcriptPath)!(transcriptPath);
        await worker.ensureUpToDate();
        expect(search('garnet')).toEqual([]);
        expect(search('quartz')).toEqual([]);
        expect(search('amethyst')).toEqual([]);
        if (isFx) expect(search('citrine')).toEqual([]);
        const removedDb = openDeepIndexDb({ dbPath: worker.getDeepDbPath()! });
        try { expect(removedDb.listExternalSourceStates()).toEqual([]); }
        finally { removedDb.close(); }
        await worker.stop();
        expect(fileChanges.size).toBe(0);
        expect(topologyChanges.size).toBe(0);
      };
    });
    it('indexes append and removal through the shared source observer', async () => {
      if (!runScenario) throw new Error('Native observation fixture did not initialize');
      await runScenario();
    });
    if (agentId === 'codex') {
      it('settles all 300 admitted transcripts before its explicit demand returns', async () => {
        await codexCorpus!.prepare();
        await codexCorpus!.demand();
      });
      describe('with a settled 300-transcript corpus', () => {
        beforeEach(async () => { await codexCorpus!.prepare(); await codexCorpus!.demand(); });
        it('indexes a new sibling through the retained daemon observation on the next demand', async () => {
          await codexCorpus!.appendSibling();
        });
      });
    }
    afterEach(async () => {
      await cleanup?.();
      runScenario = undefined;
      cleanup = undefined;
      codexCorpus = undefined;
    });
  });
});
