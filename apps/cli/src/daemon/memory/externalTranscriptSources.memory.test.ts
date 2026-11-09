import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

import { normalizeMemorySettings } from '@happier-dev/protocol/memory/memorySettings';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { createMemoryExternalTranscriptSources } from './testkit/externalTranscriptSources';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { externalMemoryStorageId } from './externalTranscriptIndex';
import type { Disposable } from '@happier-dev/plugin-sdk';
import { createInitialCodexExternalSessionIndexCursor, encodeCodexExternalSessionIndexCursor } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/candidates';

const pluginId = 'acme.memory-inventory';
const agentId = `${pluginId}/fixture`;

// Keep cold graph transformation outside the per-scenario workload deadline.
await import('@/plugins/testkit/admittedRuntime');
await import('./externalTranscriptSources');

type ConfigureInventory = (next: (page: number) => string | null,
  options?: Readonly<{ available?: boolean; watchedFiles?: number; candidates?: boolean; headId?: string; unavailableIds?: readonly string[]; searchIncomplete?: boolean }>) => void;

async function withInventory(run: (sources: ReturnType<typeof createMemoryExternalTranscriptSources>, configure: ConfigureInventory,
  signal: AbortSignal, settings: ReturnType<typeof normalizeMemorySettings>, demands: WeakRef<Disposable>[], db: ReturnType<typeof openDeepIndexDb>,
  notifyTopology: (kind?: 'file' | 'topology') => void,
  inspectSplit?: Readonly<{ stopReader(): Promise<void>; readSnapshot(): unknown; createReader(): Promise<number>;
    readCounts(): Readonly<{ inventory: number; transcript: number }>; readTranscript(): Promise<unknown> }>) => Promise<void>, split = false,
  onChange: (refreshSources: boolean) => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-memory-inventory-'));
  const db = openDeepIndexDb({ dbPath: join(directory, 'index.sqlite') });
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test' });
  vi.resetModules();
  const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
  const { createAuthoredAdmittedPluginRuntimeFixture: createRuntime } = await import('@/plugins/testkit/admittedRuntime');
  const { resolvePluginContributes } = await import('@/plugins/projection/registry/resolvePluginContributions');
  const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
  const { createExternalSessionObservationReconciler } = await import('@/api/session/external/leases/createExternalSessionObservationReconciler');
  let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
  let sources: ReturnType<typeof createMemoryExternalTranscriptSources> | undefined;
  const topologyChanges = new Map<string, (changedFile?: string) => void>();
  const contentChanges = new Map<string, (changedFile?: string) => void>();
  // Use the actual batched directory-delivery owner so both OS event kinds
  // reach source inventory; the projection's legacy test hook is structural-only.
  const observation = createExternalSessionObservationReconciler({
    // Replace only OS attachments; admission, resource sharing and disposal stay real.
    acquireObserver: async () => ({ dispose() {} }),
    watchFile: () => () => {},
    watchTopologyDirectories: (targets, lifecycle) => {
      for (const target of targets) {
        topologyChanges.set(target.directory, target.onStructuralChange);
        if (target.onFileChange) contentChanges.set(target.directory, target.onFileChange);
      }
      lifecycle.onReady();
      return () => { for (const target of targets) { topologyChanges.delete(target.directory); contentChanges.delete(target.directory); } };
    },
  });
  try {
    runtime = await createRuntime({ controller: pluginReloadController,
      resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir })),
      plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, runtime: { apiVersion: 1, agentFactories: [{ localAgentId: 'fixture',
        locator: { module: './factory', export: 'createFixtureAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'externalSessions' },
        normalizedModulePath: 'factory.mjs', loadMode: 'immutable-js',
      }] }, contributes: { agents: [{
        id: 'fixture', title: 'Synthetic inventory', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { surfaces: ['externalSessions'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        surfaces: { externalSession: { sources: [{ sourceKind: 'inventoryFixture',
          schema: { fields: [{ kind: 'literal', name: 'kind', value: 'inventoryFixture' }] },
          key: { segments: [{ kind: 'literal', value: 'inventoryFixture' }] },
          instances: [{ kind: 'default', constants: {} }],
        }] } },
      }] } }),
      files: { 'factory.mjs': `
let next = () => null;
let available = true;
let watchedFiles = 0;
let candidates = false;
let headId = 'fixture-0';
let unavailableIds = new Set();
let searchIncomplete = false;
const readCounts = { inventory: 0, transcript: 0 };
export function counts() { return { ...readCounts }; }
export function configure(value, options = {}) {
  next = value; available = options.available ?? true; watchedFiles = options.watchedFiles ?? 0; candidates = options.candidates ?? false;
  headId = options.headId ?? 'fixture-0';
  unavailableIds = new Set(options.unavailableIds ?? []);
  searchIncomplete = options.searchIncomplete ?? false;
}
export function createFixtureAgentRuntime() { return { sessions: {} }; }
export const externalSessions = {
    async resolveSource({ source }) { return available ? { ok: true, value: { source, ...(watchedFiles ? { accountingSource: {
      resourceKey: 'synthetic-accounting', changeObservation: 'watch_file_changes', watchFileChanges: {
        files: Array.from({ length: watchedFiles }, (_, index) => '/synthetic/inventory-' + index + '.jsonl'), topologyDirectories: ['/synthetic'],
      },
    } } : {}) } } : { ok: false, code: 'unavailable', retryable: true }; },
    async listCandidates({ cursor }) {
      readCounts.inventory++;
      const page = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()).rolloutOffset : 0;
      return { ok: true, value: { candidates: candidates ? [{ remoteSessionId: page === 0 ? headId : 'fixture-' + page, updatedAtMs: Date.now() }] : [], nextCursor: next(page), ...(searchIncomplete ? { searchIncomplete: true } : {}) } };
    },
    async resolveLinkIdentity({ source, remoteSessionId }) { return unavailableIds.has(remoteSessionId)
      ? { ok: false, code: 'unavailable', retryable: true }
      : { ok: true, value: { source, remoteSessionId, linkData: {} } }; },
    async resolveLinkedIdentity({ source, remoteSessionId, linkData }) { return { ok: true, value: { source, remoteSessionId, linkData } }; },
    async pageTranscript() { readCounts.transcript++; return { ok: true, value: { items: [], nextCursor: null } }; },
    async readAfterTranscript() { return { ok: true, value: { outcome: 'already_current' } }; },
};`, 'daemon.mjs': `
import { createFixtureAgentRuntime, externalSessions } from './factory.mjs';
export { configure, counts } from './factory.mjs';
export function activate(api) {
  api.agents.register('fixture', createFixtureAgentRuntime, { sessionRunnerFactory: {
    module: './factory', export: 'createFixtureAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'externalSessions',
  } });
  api.agents.registerExternalSessions('fixture', externalSessions);
}` },
    }] });
    if (!runtime.registry.agentRuntimesByAgentId.get(agentId)?.externalSessions) {
      throw new Error(`Synthetic external reader was not admitted: ${JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId[pluginId])}`);
    }
    const configureExport = runtime.modulesByPluginId.get(pluginId)?.configure;
    if (typeof configureExport !== 'function') throw new Error('Synthetic plugin configuration export unavailable');
    const configure: ConfigureInventory = (next, options) => { configureExport(next, options); };
    const { createMemoryExternalTranscriptSources: createSources } = await import('./testkit/externalTranscriptSources');
    let inspectSplit: Parameters<typeof run>[7];
    if (split) {
      const { createMemoryExternalTranscriptObservation, createMemoryExternalTranscriptReader } = await import('./externalTranscriptSources');
      const daemon = createMemoryExternalTranscriptObservation({ credentials: { token: 'fixture', encryption: null }, onChange() {} });
      const makeReader = () => createMemoryExternalTranscriptReader({
        resolveReader: async id => runtime?.registry.agentRuntimesByAgentId.get(id)?.externalSessions ?? null,
        onChange,
      });
      let reader = makeReader();
      sources = { ...reader, attach: daemon.attach,
        async refresh(settings, signal) { await daemon.refresh(settings, signal); await reader.refresh(daemon.takeSnapshot(), settings, signal); },
        async dispose() { await reader.dispose(); await daemon.dispose(); },
      };
      const readCounts = runtime.modulesByPluginId.get(pluginId)?.counts;
      if (typeof readCounts !== 'function') throw new Error('Synthetic plugin counts export unavailable');
      inspectSplit = { stopReader: () => reader.dispose(), readSnapshot: daemon.getSnapshot,
        readCounts: () => readCounts() as { inventory: number; transcript: number },
        readTranscript: () => {
          const source = daemon.getSnapshot().sources[0]!;
          return reader.readPage({ source: { type: 'external_transcript', agentId: source.agentId,
            sourceKey: source.sourceKey, nativeSessionId: 'fixture-0' } }, settings, signal);
        },
        async createReader() {
          reader = makeReader();
          await reader.refresh(JSON.parse(JSON.stringify(daemon.takeSnapshot())), settings, signal);
          await reader.inventory(signal);
          return reader.getReadySourceCount();
        } };
    } else sources = createSources({ credentials: { token: 'fixture', encryption: null }, onChange });
    const demands: WeakRef<Disposable>[] = [];
    sources.attach({ registerAccountingSource: async input => {
      const demand = await observation.registerAccountingSource(input);
      demands.push(new WeakRef(demand));
      return demand;
    } });
    const signal = new AbortController().signal;
    const settings = normalizeMemorySettings({ v: 1, enabled: true, conversationSearch: { indexExternal: { enabled: true, agents: [agentId] } } });
    expect(settings.conversationSearch.indexExternal).toMatchObject({ enabled: true, agents: [agentId] });
    await sources.refresh(settings, signal);
    await run(sources, configure, signal, settings, demands, db, (kind = 'topology') => {
      const notify = (kind === 'file' ? contentChanges : topologyChanges).get('/synthetic');
      if (!notify) throw new Error('Synthetic source has no admitted topology watcher');
      notify('/synthetic/new-sibling.jsonl');
    }, inspectSplit);
  } finally {
    await sources?.dispose();
    await observation.dispose();
    await runtime?.dispose();
    await pluginReloadController.shutdown();
    db.close();
    env.restore();
    vi.resetModules();
    await rm(directory, { recursive: true, force: true });
  }
}

const cursor = (page: number) => encodeCodexExternalSessionIndexCursor({ ...createInitialCodexExternalSessionIndexCursor(), rolloutOffset: page });

describe('native inventory cursor lifetime', () => {
  it('does not re-demand an already removed native source retained by incomplete inventory', async () => {
    let refreshRequested = false;
    await withInventory(async (sources, configure, signal, settings, _demands, _db, notifyTopology) => {
      configure(() => null, { watchedFiles: 1, candidates: true });
      await sources.refresh(settings, signal);
      await sources.inventory(signal);
      const candidate = sources.take(1)[0]!;
      sources.noteSyncResult(candidate.source, 'current');
      configure(() => null, { watchedFiles: 1, searchIncomplete: true });
      notifyTopology();
      await sources.inventory(signal);
      refreshRequested = false;
      sources.noteSyncResult(candidate.source, 'removed');
      expect(sources.hasPendingWork()).toBe(true);
      // Match the process engine: a reader refresh request reaches the daemon
      // topology owner before the next admitted inventory turn.
      if (refreshRequested) await sources.refresh(settings, signal);
      await sources.inventory(signal);
      sources.noteSyncResult(candidate.source, 'removed');
      expect(sources.hasPendingWork()).toBe(false);
    }, false, refreshSources => { refreshRequested ||= refreshSources; });
  });
  it('settles an incomplete terminal inventory and retries on a later source observation', async () => {
    await withInventory(async (sources, configure, signal, settings, _demands, _db, notifyTopology) => {
      let inventoryPages = 0;
      configure(() => { inventoryPages++; return null; }, { watchedFiles: 1, searchIncomplete: true });
      await sources.refresh(settings, signal);
      expect((await sources.inventory(signal))?.completeSources.size).toBe(0);
      expect(sources.hasPendingWork()).toBe(false);
      // An ordinary source-processing turn is not a new observation. Retained
      // incomplete coverage must not restart vendor IO while another source drains.
      await sources.inventory(signal);
      expect(inventoryPages).toBe(1);
      configure(() => null, { watchedFiles: 1 });
      notifyTopology();
      expect((await sources.inventory(signal))?.completeSources.size).toBe(1);
      expect(sources.hasPendingWork()).toBe(false);
    });
  });
  it('keeps daemon observation alive without an indexer and transfers serializable hints to a fresh reader', async () => {
    await withInventory(async (sources, configure, signal, settings, _demands, _db, notifyTopology, split) => {
      configure(() => null, { watchedFiles: 1, candidates: true });
      await sources.refresh(settings, signal);
      expect(sources.getReadySourceCount()).toBe(0);
      expect(split!.readCounts()).toEqual({ inventory: 0, transcript: 0 });
      await split!.stopReader();
      notifyTopology();
      expect(split!.readSnapshot()).toMatchObject({ sources: [{ agentId }], changes: [{ agentId, refreshSources: true }] });
      expect(split!.readSnapshot()).toMatchObject({ changes: [{ agentId, refreshSources: true }] });
      expect(split!.readCounts()).toEqual({ inventory: 0, transcript: 0 });
      expect(await split!.createReader()).toBe(1);
      expect(split!.readCounts()).toEqual({ inventory: 1, transcript: 0 });
      await split!.readTranscript();
      expect(split!.readCounts()).toEqual({ inventory: 1, transcript: 1 });
    }, true);
  });
  it('prioritizes a newly discovered sibling after inventory completes while transcript backfill remains', async () => {
    await withInventory(async (sources, configure, signal, settings, _demands, _db, notifyTopology) => {
      configure(() => null, { watchedFiles: 1, candidates: true });
      await sources.refresh(settings, signal);
      const initial = await sources.inventory(signal);
      expect(initial?.completeSources.size).toBe(1);
      const main = sources.take(1)[0]!;
      sources.noteSyncResult(main.source, 'more');
      configure(page => page < 6 ? cursor(page + 1) : null,
        { watchedFiles: 1, candidates: true, headId: 'new-sibling' });
      notifyTopology();
      await sources.inventory(signal);
      const selected: string[] = [];
      for (let turn = 0; turn < 2; turn++) {
        const next = sources.take(1)[0]!;
        selected.push(next.source.nativeSessionId);
        sources.noteSyncResult(next.source, 'more');
      }
      expect(selected).toContain('new-sibling');
    });
  });
  it('does not complete initial coverage when a listed native identity could not be read', async () => {
    await withInventory(async (sources, configure, signal, _settings, _demands, db) => {
      configure(page => page === 0 ? cursor(1) : null, { candidates: true, unavailableIds: ['fixture-1'] });
      await sources.inventory(signal);
      await sources.inventory(signal);
      for (const candidate of sources.take(sources.getReadySourceCount())) {
        db.setExternalSourceState({ sessionId: externalMemoryStorageId(candidate.source),
          source: candidate.source, cursor: JSON.stringify({ type: 'tail' }), nextOrdinal: 1 });
        sources.noteSyncResult(candidate.source, 'current');
      }
      expect(sources.getIndexSources(db)).toMatchObject([{ state: 'indexing' }]);
      // Unavailable identities preserve incomplete coverage; they are not an
      // admitted continuation that may spin a finite demand indefinitely.
      expect(sources.hasPendingWork()).toBe(false);
    });
  });
  it.each(['file', 'topology'] as const)('discovers new siblings from a %s event during a retained crawl without starving its initial coverage', async kind => {
    await withInventory(async (sources, configure, signal, settings, _demands, db, notifyTopology) => {
      const lastPage = 6;
      const next = (page: number) => page < lastPage ? cursor(page + 1) : null;
      configure(next, { watchedFiles: 1, candidates: true });
      await sources.refresh(settings, signal);
      await sources.inventory(signal);
      configure(next, { watchedFiles: 1, candidates: true, headId: 'new-sibling' });
      notifyTopology(kind);
      const changed = await sources.inventory(signal);
      expect(sources.take(1).map(candidate => candidate.source.nativeSessionId)).toEqual(['new-sibling']);
      const ids = () => sources.take(sources.getReadySourceCount()).map(candidate => candidate.source.nativeSessionId);
      expect(ids()).toContain('new-sibling');
      expect(changed?.completeSources.size).toBe(0);
      // More structural writes must not reset either active continuation. The
      // initial crawl gets one of every two pages under the existing allowance.
      for (let page = 0; page < lastPage * 2; page++) {
        notifyTopology(kind);
        await sources.inventory(signal);
      }
      expect(ids()).toEqual(expect.arrayContaining(Array.from({ length: lastPage }, (_, index) => `fixture-${index + 1}`)));
      const visited = sources.take(sources.getReadySourceCount());
      for (const candidate of visited) {
        db.setExternalSourceState({ sessionId: externalMemoryStorageId(candidate.source),
          source: candidate.source, cursor: JSON.stringify({ type: 'tail' }), nextOrdinal: 1 });
        sources.noteSyncResult(candidate.source, 'current');
      }
      expect(sources.getIndexSources(db)).toMatchObject([{ state: 'ready' }]);
      let completed = await sources.inventory(signal);
      for (let page = 0; page < (lastPage + 1) * 2 && completed?.completeSources.size !== 1; page++) {
        completed = await sources.inventory(signal);
      }
      expect(completed?.completeSources.size).toBe(1);
      expect(await sources.inventory(signal)).toBeNull();
    });
  });
  it('reports a configured but unreadable native source as unavailable and recovers when it returns', async () => {
    await withInventory(async (sources, configure, signal, settings, _demands, db) => {
        configure(() => null, { available: false });
        await sources.refresh(settings, signal);
        await sources.inventory(signal);
        expect(sources.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'agent_unavailable' }]);
        configure(() => null);
        await sources.refresh(settings, signal);
        await sources.inventory(signal);
        expect(sources.getIndexSources(db)).toMatchObject([{ state: 'ready' }]);
        configure(() => null, { available: false });
        await sources.refresh(settings, signal);
        expect(sources.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'agent_unavailable' }]);
        expect(sources.getReadySourceCount()).toBe(0);
    });
  });

  it('leaves opaque inventory continuation to the trusted reader until exhaustion', async () => {
    await withInventory(async (sources, configure, signal, _settings, _demands, db) => {
      let inventoryPages = 0;
      configure(() => ++inventoryPages < 3 ? cursor(1) : null);
      for (let page = 0; page < 3; page++) await sources.inventory(signal);
      expect(inventoryPages).toBe(3);
      expect(sources.getIndexSources(db)).toMatchObject([{ state: 'ready' }]);
      expect(sources.hasPendingWork()).toBe(false);
      expect(await sources.inventory(signal)).toBeNull();
    });
  });

  it.skipIf(!process.env.HAPPIER_R240_INVENTORY_MEMORY)('releases retired observation demands while retaining inventory candidates', async () => {
    setFlagsFromString('--expose_gc');
    const collectGarbage = runInNewContext('gc') as () => void;
    await withInventory(async (sources, configure, signal, settings, demands) => {
      configure(page => page < 2 ? cursor(page + 1) : null, { watchedFiles: 300, candidates: true });
      for (let page = 0; page <= 2; page++) {
        await sources.refresh(settings, signal);
        await sources.inventory(signal);
      }
      await sources.refresh(settings, signal);
      await setImmediate(); collectGarbage();
      await setImmediate(); collectGarbage();
      const retiredRetained = demands.slice(0, -1).filter(demand => demand.deref() !== undefined).length;
      console.info('R240_INVENTORY_DEMANDS', JSON.stringify({ demands: demands.length, retiredRetained }));
      expect(sources.getReadySourceCount()).toBe(3);
      expect(demands).toHaveLength(4);
      expect(retiredRetained).toBe(0);
      expect(demands.at(-1)?.deref()).toBeDefined();
    });
  });

  it.skipIf(!process.env.HAPPIER_R240_INVENTORY_MEMORY)('retains one opaque preparation cursor while crawling and none after exhaustion', async () => {
    // Expose GC only inside this isolated synthetic workload; no live daemon
    // Inspector, heap snapshot, user home or transcript is accessed.
    setFlagsFromString('--expose_gc');
    const collectGarbage = runInNewContext('gc') as () => void;
    await withInventory(async (sources, configure, signal, settings) => {
      const preparation = { roots: 'synthetic', directories: [{ ref: { home: 0, path: 'sessions/2026/10/21' }, generation: 'synthetic',
        entries: Array.from({ length: 1500 }, (_, index) => ({ name: `rollout-2026-10-21T00-00-00-00000000-0000-4000-8000-${String(index).padStart(12, '0')}.jsonl`, kind: 'file' })) }], files: [], identities: [] };
      let emittedBytes = 0;
      let cursorBytes = 0;
      configure(page => {
        if (page === 128) return null;
        const next = encodeCodexExternalSessionIndexCursor({ ...createInitialCodexExternalSessionIndexCursor(), rolloutOffset: page + 1, preparation });
        cursorBytes = Buffer.byteLength(next);
        emittedBytes += cursorBytes;
        return next;
      });
      const sample = () => { collectGarbage(); return process.memoryUsage().heapUsed; };
      const baseline = sample();
      for (let page = 0; page < 64; page++) await sources.inventory(signal);
      const crawling = sample() - baseline;
      for (let page = 64; page <= 128; page++) await sources.inventory(signal);
      const exhausted = sample() - baseline;
      await sources.refresh({ ...settings, enabled: false }, signal);
      const disabled = sample() - baseline;
      console.info('R240_INVENTORY_MEMORY', JSON.stringify({ cursorBytes, emittedBytes, crawling, exhausted, disabled }));
      expect(emittedBytes).toBeGreaterThan(0);
      // A crawl cannot retain the history of native directory snapshots. The
      // allowance covers its latest cursor and transient host bookkeeping;
      // it scales with a page, never the number of previously consumed pages.
      expect(crawling).toBeLessThan(cursorBytes * 4);
      expect(exhausted).toBeLessThan(cursorBytes * 4);
      expect(sources.getReadySourceCount()).toBe(0);
    });
  });
});
