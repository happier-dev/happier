import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { createRegistryHostV1, RegistryProvenanceV1Schema, RegistryUpstreamV1Schema, RegistryUpstreamCheckV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
  type RegistrySourceDescriptorV1, type RegistryHttpV1 } from '@happier-dev/protocol/registries';
import { ACP_REGISTRY_V1_FIXTURE } from '../../../../../packages/protocol/src/registries/formats/fixtures/acpRegistryV1Fixture';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createRegistryHttpV1 } from '../registryHttp';
import { createRegistryUpdateCheck, type RegistryUpdateTrackerV1 } from './registryUpdateTracker';
import { startBackgroundRuntimeInstallableUpdate } from '@/packagedRuntime/installables/startBackgroundUpdate';
import { readRuntimeInstallableLastCheckAtMs } from '@/packagedRuntime/installables/updateState';
import { configuration } from '@/configuration';
import { mkdir } from 'node:fs/promises';

const source: RegistrySourceDescriptorV1 = { id: 'test-repo', title: 'Repo', format: 'git', kinds: ['skill'],
  url: 'https://github.com/test/repo', enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
const commit = '1'.repeat(40), next = '2'.repeat(40);

async function fixture(stateDir: string) {
  let head = commit, treeSha = 'old-tree', limited = false, requests = 0;
  const unused = async (): Promise<never> => { throw new Error('Unexpected HTTP request'); };
  const http: RegistryHttpV1 = { getJson: async url => {
    ++requests;
    if (limited) return { ok: false, status: { state: 'rate_limited' } };
    return { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: head } : { sha: treeSha,
      tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 1 }] } };
  }, getText: async () => ({ ok: true, fetchedAt: 1, value: '# Skill\n' }), getBytes: unused };
  const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [source] });
  const item = await host.readRegistryItem({ sourceId: source.id, itemId: '', version: commit });
  const provenance = RegistryProvenanceV1Schema.parse({ sourceId: source.id, format: source.format, sourceUrl: source.url,
    itemId: '', ref: item.payload.skill.ref, importedAt: item.fetchedAt });
  const statePath = join(stateDir, 'observation.json');
  await writeFile(statePath, JSON.stringify({ state: 'current', latest: provenance.ref }));
  const changes: Parameters<RegistryUpdateTrackerV1['record']>[0][] = [];
  // Filesystem is the tracker boundary; all check, comparison, Action and strict consumption logic is real.
  const tracker: RegistryUpdateTrackerV1 = { kind: 'skill', list: async () => [{ key: 'skill', provenance,
    upstream: RegistryUpstreamV1Schema.parse(JSON.parse(await readFile(statePath, 'utf8'))) }],
    record: async updates => { changes.push(updates); await writeFile(statePath, JSON.stringify(updates[0]!.upstream)); } };
  const check = createRegistryUpdateCheck({ trackers: [tracker], ctx: { http }, readSources: async () => [source] });
  return { check, tracker, http, provenance, changes, requests: () => requests,
    move: () => { head = next; treeSha = 'new-tree'; }, limit: () => { limited = true; } };
}

describe('registry tracker coordinator through Actions and strict result consumption', () => {
  afterEach(() => vi.useRealTimers());
  it('joins native version checks with catalog trackers without fabricating provenance or persisting failed observations', async () => withTempDir('happier-registry-native-', async dir => {
    const f = await fixture(dir);
    const statePath = join(dir, 'browser-observation.json');
    let nativeCalls = 0;
    let available = true;
    // Native acquisition is an external HTTP boundary; this tracker reads and records its real filesystem observation.
    const http: RegistryHttpV1 = { ...f.http, getJson: async (url, options) => url === 'https://extensions.example/latest'
      ? { ok: true, fetchedAt: 1, value: available ? { state: 'update_available', latest: { kind: 'version', version: '2.0' } }
        : { state: 'unchecked', reason: { state: 'unreachable' } } } : f.http.getJson(url, options) };
    const key = JSON.stringify(['work', 'a'.repeat(32)]);
    const native = {
      kind: 'browserExtension' as const,
      list: async () => [{ key }],
      check: async (items: readonly Readonly<{ key: string }>[]) => {
        nativeCalls += 1;
        const response = await http.getJson('https://extensions.example/latest');
        if (!response.ok) throw new Error('Unexpected transport refusal');
        return new Map(items.map(item => [item.key, RegistryUpstreamCheckV1Schema.parse(response.value)]));
      },
      record: async (changes: Parameters<RegistryUpdateTrackerV1['record']>[0]) => {
        await writeFile(statePath, JSON.stringify(changes));
      },
    };
    const check = createRegistryUpdateCheck({ trackers: [f.tracker, native], ctx: { http }, readSources: async () => [source] });
    const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [source], updates: check.checkNow });
    const consumed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(await host.execute('registries.updates.check', {}));
    expect(consumed.results).toMatchObject([{ kind: 'skill', key: 'skill', upstream: { state: 'current' } },
      { kind: 'browserExtension', key, upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } }]);
    const recorded = await readFile(statePath, 'utf8');
    expect(JSON.parse(recorded)).toEqual([{ key, upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } }]);
    available = false;
    expect((await check.checkNow({ kind: 'browserExtension', keys: [key] })).results).toEqual([
      { kind: 'browserExtension', key, upstream: { state: 'unchecked', reason: { state: 'unreachable' } } },
    ]);
    expect(await readFile(statePath, 'utf8')).toBe(recorded);
    expect(nativeCalls).toBe(2);
  }));
  it('reports an unavailable check machine as the registry typed refusal', async () => withTempDir('happier-registry-no-machine-', async dir => {
    const f = await fixture(dir);
    const host = createRegistryHostV1({ host: 'web', http: f.http, readSources: async () => [source] });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      registryActionExecute: ({ actionId, input }) => host.execute(actionId, input) });
    expect(await executor.execute('registries.updates.check', { kind: 'skill' }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'needs_machine', details: { registryStatus: { state: 'needs_machine' } } });
    expect(f.changes).toEqual([]);
  }));

  it('does not trust a raw transport error code as a typed registry refusal', async () => withTempDir('happier-registry-raw-error-', async dir => {
    const f = await fixture(dir);
    const raw = Object.assign(new Error('Transport implementation failure'), { code: 'needs_machine' });
    const http: RegistryHttpV1 = { ...f.http, getJson: async () => { throw raw; } };
    const check = createRegistryUpdateCheck({ ctx: { http }, trackers: [f.tracker], readSources: async () => [source] });
    const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [source], updates: check.checkNow });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      registryActionExecute: ({ actionId, input }) => host.execute(actionId, input) });
    expect(await executor.execute('registries.updates.check', { kind: 'skill' }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'action_failed' });
    expect(f.changes).toEqual([]);
  }));

  it('uses the real installables gate and retained state interval without another registry schedule', async () => withTempDir('happier-registry-gate-', async dir => {
    vi.useFakeTimers(); vi.setSystemTime(5000);
    const f = await fixture(dir), key = `registry-items:${dir}`, interval = configuration.installablesRuntimeAutoUpdateCheckIntervalMs;
    const environment = { ...process.env, HAPPIER_HOME_DIR: dir };
    const stateDir = join(dir, 'installables');
    await mkdir(stateDir, { recursive: true });
    const dependencies = {
      autoUpdateCheckIntervalMs: interval,
      readLastCheckAtMs: (id: string) => readRuntimeInstallableLastCheckAtMs(id, environment),
      // Only the filesystem destination is substituted; the gate and its
      // canonical retained-state reader execute in process on a real temp dir.
      writeLastCheckAtMs: async (id: string, at: number) => writeFile(join(stateDir, 'runtime-auto-update-state.json'),
        JSON.stringify({ lastCheckAtMsByInstallableKey: { [id]: at } })),
    };
    await startBackgroundRuntimeInstallableUpdate({ installableKey: key, adapter: f.check }, dependencies);
    expect(await readRuntimeInstallableLastCheckAtMs(key, environment)).toBe(5000);
    const afterFirst = f.requests();
    await startBackgroundRuntimeInstallableUpdate({ installableKey: key, adapter: f.check }, dependencies);
    expect(f.requests()).toBe(afterFirst);
    vi.setSystemTime(5000 + interval + 1);
    await startBackgroundRuntimeInstallableUpdate({ installableKey: key, adapter: f.check }, dependencies);
    expect(f.requests()).toBeGreaterThan(afterFirst);
    expect(f.changes).toEqual([]);
  }));

  it('records only changed observations and preserves the run provenance for the kind CAS', async () => withTempDir('happier-registry-check-', async dir => {
    vi.useFakeTimers(); vi.setSystemTime(5000);
    const f = await fixture(dir);
    expect((await f.check.checkNow()).checkedAt).toBe(5000);
    expect(f.changes).toEqual([]);
    f.move();
    const result = await f.check.checkNow({ kind: 'skill', keys: ['skill'] });
    expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(JSON.parse(JSON.stringify(result)))).toMatchObject({
      results: [{ kind: 'skill', key: 'skill', upstream: { state: 'update_available', latest: { commit: next } } }],
    });
    expect(f.changes).toHaveLength(1);
    expect(f.changes[0]![0]).toMatchObject({ key: 'skill', provenance: f.provenance });
    await f.check.checkNow();
    expect(f.changes).toHaveLength(1);
  }));

  it('runs Check now through the registered Action host and returns unchecked recovery evidence without storing it', async () => withTempDir('happier-registry-action-', async dir => {
    const f = await fixture(dir); f.limit();
    const host = createRegistryHostV1({ host: 'node', http: f.http, readSources: async () => [source], updates: f.check.checkNow });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      registryActionExecute: ({ actionId, input }) => host.execute(actionId, input) });
    const response = await executor.execute('registries.updates.check', { kind: 'skill', keys: ['skill'] }, { surface: 'cli' });
    expect(response.ok).toBe(true); if (!response.ok) throw new Error(response.errorCode);
    const consumed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(JSON.parse(JSON.stringify(response.result)));
    expect(consumed.results).toEqual([{ kind: 'skill', key: 'skill', upstream: { state: 'unchecked', reason: { state: 'rate_limited' } } }]);
    expect(f.changes).toEqual([]);
    expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].safeParse({ ...response.result as object, unexpected: true }).success).toBe(false);
  }));

  it('filters before fetching and retains distinct keys across tracker kinds', async () => withTempDir('happier-registry-filter-', async dir => {
    const f = await fixture(dir), baseline = f.requests();
    expect((await f.check.checkNow({ kind: 'agent' })).results).toEqual([]);
    expect((await f.check.checkNow({ keys: ['missing'] })).results).toEqual([]);
    expect(f.requests()).toBe(baseline);
    const agentSource: RegistrySourceDescriptorV1 = { ...source, id: 'agent-registry', format: 'acp-registry', kinds: ['agent'], url: 'https://acp.example/registry.json' };
    const http: RegistryHttpV1 = { ...f.http, getJson: (url, options) => url === agentSource.url
      ? Promise.resolve({ ok: true, fetchedAt: 1, value: ACP_REGISTRY_V1_FIXTURE }) : f.http.getJson(url, options) };
    const agentHost = createRegistryHostV1({ host: 'node', http, readSources: async () => [agentSource] });
    const response = await agentHost.fetchRequest({ op: 'read', sourceId: agentSource.id, kind: 'agent', itemId: 'goose' });
    if (response.op !== 'read') throw new Error('Agent fixture unavailable');
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: agentSource.id, sourceUrl: agentSource.url, format: agentSource.format,
      itemId: response.item.summary.itemId, ref: { kind: 'version', version: response.item.summary.version }, importedAt: response.item.fetchedAt });
    const other: RegistryUpdateTrackerV1 = { ...f.tracker, kind: 'agent', list: async () => [{ key: 'skill', provenance, upstream: { state: 'current', latest: provenance.ref } }] };
    const check = createRegistryUpdateCheck({ trackers: [f.tracker, other], ctx: { http }, readSources: async () => [source, agentSource] });
    const results = (await check.checkNow()).results;
    expect(results.map(result => [result.kind, result.key])).toEqual([['skill', 'skill'], ['agent', 'skill']]);
    expect(results.every(result => result.upstream.state === 'current')).toBe(true);
  }));

  it('revalidates through the real HTTP memo and leaves a 304 observation unchanged', async () => withTempDir('happier-registry-304-', async dir => {
    const f = await fixture(dir); let responses = 0;
    const http = createRegistryHttpV1({ fetch: async (_url, init) => {
      ++responses;
      if (responses === 1) return Response.json({ sha: commit }, { headers: { etag: '"commit"' } });
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"commit"');
      return new Response(null, { status: 304 });
    } });
    const check = createRegistryUpdateCheck({ trackers: [f.tracker], ctx: { http }, readSources: async () => [source] });
    expect((await check.checkNow()).results[0]?.upstream.state).toBe('current');
    expect((await check.checkNow()).results[0]?.upstream.state).toBe('current');
    expect(responses).toBe(2); expect(f.changes).toEqual([]);
  }));

  it('preserves Account cancellation through the tracker record boundary', async () => withTempDir('happier-registry-cancel-', async dir => {
    const f = await fixture(dir); f.move();
    const controller = new AbortController(), reason = new Error('Account retired');
    const check = createRegistryUpdateCheck({ ctx: { http: f.http, signal: controller.signal },
      trackers: [{ ...f.tracker, list: async () => { const items = await f.tracker.list(); controller.abort(reason); return items; } }],
      readSources: async () => [source] });
    await expect(check.checkNow()).rejects.toBe(reason);
    expect(f.changes).toEqual([]);
  }));
});
