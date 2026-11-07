import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { checkRegistryUpstreamV1, compareRegistryContentRefV1, registryUpstreamEqualV1, RegistryUpdateCheckResultV1Schema } from './registryUpdatesV1.js';
import { RegistryItemV1Schema, RegistryProvenanceV1Schema, type RegistryContentRefV1 } from './registryItemsV1.js';
import { githubRegistryAdapterV1 } from './formats/github.js';
import type { RegistryHttpV1 } from './formats/registryFormatAdapterV1.js';
import type { RegistrySourceDescriptorV1 } from './registrySourcesV1.js';
import { acpRegistryAdapterV1 } from './formats/acpRegistry.js';
import { ACP_REGISTRY_V1_FIXTURE } from './formats/fixtures/acpRegistryV1Fixture.js';
import { claudeMarketplaceRegistryAdapterV1 } from './formats/claudeMarketplace.js';
import { composeCatalogRegistryAdapterV1 } from './formats/composeCatalog.js';
import { computeGitBlobShaV1 } from './registryGitTreeV1.js';
import type { RegistrySourceStatusV1 } from './registryListV1.js';
import { happierCatalogRegistryAdapterV1 } from './formats/happierCatalog.js';
import { normalizeComposeTemplateV1 } from './formats/composeTemplateNormalizationV1.js';
import { createRegistryHostV1 } from './registryHostV1.js';
import { RegistryPackagedSourceDescriptorV1Schema } from './registrySourcesV1.js';
import { REGISTRY_ACTION_INPUT_SCHEMAS_V1 } from './registryActionsV1.js';
import { checkRegistryAppUpdatesV1 } from './registryUpdatesV1.js';

const commit = '1'.repeat(40), next = '2'.repeat(40);
const source: RegistrySourceDescriptorV1 = { id: 'repo', title: 'Repo', format: 'git', kinds: ['skill'],
  url: 'https://github.com/a/b', ref: 'release', path: 'skills', token: { secretRef: 'private-token' },
  enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };

function fixture() {
  let head = commit, subtree: string | null = 'subtree';
  const calls: { url: string; sourceId?: string; token?: string }[] = [];
  const unused = async (): Promise<never> => { throw new Error('Unexpected HTTP method'); };
  const http: RegistryHttpV1 = {
    async getJson(url, options) {
      calls.push({ url, sourceId: options?.source?.id, token: options?.source?.token?.secretRef });
      return { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: head } : { sha: 'root', tree: subtree ? [
        { path: 'skills/review', type: 'tree', mode: '040000', sha: subtree },
        { path: 'skills/review/SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 1 },
      ] : [] } };
    },
    getText: async () => ({ ok: true, fetchedAt: 1, value: '# Review\n' }), getBytes: unused,
  };
  return { http, calls, move: (sha: string, tree: string | null) => { head = sha; subtree = tree; } };
}
async function imported(http: RegistryHttpV1) {
  const item = await githubRegistryAdapterV1.read({ http }, { source, kind: 'skill', itemId: 'review' });
  return { ...RegistryProvenanceV1Schema.parse({ sourceId: source.id, format: source.format, sourceUrl: source.url,
    itemId: item.summary.itemId, ref: item.payload.skill.ref, importedAt: item.fetchedAt }), ref: item.payload.skill.ref };
}

async function appFixture() {
  const appSource: RegistrySourceDescriptorV1 = { ...source, id: 'apps', format: 'coolify-templates', kinds: ['app'],
    url: 'https://github.com/example/apps', path: undefined, ref: undefined };
  let head = commit, body = 'services:\n  web:\n    image: nginx:1\n', present = true, ignored = false;
  let failure: Exclude<RegistrySourceStatusV1, { state: 'ok' }> | undefined;
  const calls: { method: 'json' | 'text'; url: string }[] = [];
  const http: RegistryHttpV1 = {
    getJson: async (url, options) => {
      calls.push({ method: 'json', url });
      expect(options?.source?.token).toEqual(appSource.token);
      if (failure) return { ok: false, status: failure };
      return { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: head }
        : url.includes('/git/trees/') ? { truncated: false, tree: present ? [{ path: 'templates/compose/web.yaml',
          mode: '100644', type: 'blob', sha: computeGitBlobShaV1(new TextEncoder().encode(body)) }] : [] }
        : { ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`other-${i}`, { compose: 'invalid-base64' }])),
          web: { slogan: 'Web app', compose: 'invalid-base64', ...(ignored ? { ignore: true } : {}) } } };
    },
    getText: async url => { calls.push({ method: 'text', url }); return { ok: true, fetchedAt: 1, value: body }; },
    getBytes: async () => { throw new Error('Updates must not fetch image or body bytes'); },
  };
  const selected = RegistryItemV1Schema.parse(await composeCatalogRegistryAdapterV1.read({ http }, { source: appSource, kind: 'app', itemId: 'web', version: commit }));
  if (selected.payload.kind !== 'app') throw new Error('Expected selected app');
  const provenance = RegistryProvenanceV1Schema.parse({ sourceId: appSource.id, sourceUrl: appSource.url, format: appSource.format,
    itemId: selected.summary.itemId, ref: selected.payload.ref, importedAt: selected.fetchedAt });
  calls.length = 0;
  return { appSource, http, calls, provenance,
    move: (value: string) => { head = next; body = value; },
    remove: () => { present = false; }, ignore: () => { ignored = true; },
    fail: (status: Exclude<RegistrySourceStatusV1, { state: 'ok' }>) => { failure = status; } };
}

describe('registry upstream content observations', () => {
  it('admits each selected update source once for all of its upstream reads', async () => {
    const f = fixture();
    const provenance = await imported(f.http);
    f.move(next, 'next-tree');
    f.calls.length = 0;
    const admitted: string[] = [];
    const forbidden = async (): Promise<never> => { throw new Error('Unadmitted upstream transport'); };
    const result = await checkRegistryUpstreamV1({ http: { getJson: forbidden, getText: forbidden, getBytes: forbidden } }, {
      sources: [source], items: [{ key: 'skill', provenance }],
      admitSource: async selected => { admitted.push(selected.id); return { http: f.http }; },
    });
    expect(result.get('skill')).toMatchObject({ state: 'update_available', latest: { commit: next } });
    expect(admitted).toEqual([source.id]);
    expect(f.calls).toHaveLength(2);
  });

  it('admits exact Environment app demand but never caller provenance or a broad app scan', () => {
    const schema = REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.updates.check'];
    const input = { kind: 'app', environments: [{ environmentId: 'environment', expectedRevision: 3 }] };
    expect(schema.safeParse(input).success).toBe(true);
    for (const invalid of [{ kind: 'app' }, { kind: 'app', keys: ['environment'] },
      { ...input, provenance: {} }, { ...input, url: 'https://untrusted.example' },
      { ...input, environments: [{ ...input.environments[0], ref: { kind: 'version', version: '1' } }] }]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
    expect(schema.safeParse({ kind: 'skill', keys: ['skill'] }).success).toBe(true);
  });

  it('resolves only demanded instantiated Environments before canonical upstream acquisition', async () => {
    const f = await appFixture();
    const templateRef = { sourceId: f.appSource.id, itemId: f.provenance.itemId, version: commit, ref: f.provenance.ref };
    const definition = { kind: 'stored' as const, contentRevision: 2, composeDigest: `sha256:${'a'.repeat(64)}` };
    const opened: string[] = [];
    // This port is the authorized Environment transport boundary. Source parsing,
    // exact admission, finite grouping and comparison remain the production owners.
    const readEnvironment = async (environmentId: string) => {
      opened.push(environmentId);
      expect(f.calls).toEqual([]);
      return { environment: { id: environmentId, revision: 3 }, content: { definition,
        ...(environmentId === 'plain' ? {} : { template: { templateRef, definition } }) } };
    };
    const result = await checkRegistryAppUpdatesV1({ http: f.http }, {
      environments: [{ environmentId: 'selected', expectedRevision: 3 }, { environmentId: 'plain', expectedRevision: 3 }],
      readEnvironment, readSources: async () => [f.appSource],
    });
    expect(opened).toEqual(['selected', 'plain']);
    expect(result.results).toEqual([{ kind: 'app', key: 'selected', upstream: { state: 'current', latest: f.provenance.ref } }]);
    expect(f.calls.filter(call => call.url.includes('/commits/'))).toHaveLength(1);
    expect(f.calls.every(call => call.method === 'json')).toBe(true);
  });

  it('refuses stale Environment baselines while checking reloaded contributors', async () => {
    const f = await appFixture();
    const definition = { kind: 'stored' as const, contentRevision: 2, composeDigest: `sha256:${'a'.repeat(64)}` };
    const templateRef = { sourceId: f.appSource.id, itemId: f.provenance.itemId, version: commit, ref: f.provenance.ref,
      expectedContributorOccurrenceId: 'previous-occurrence' };
    const appSource: RegistrySourceDescriptorV1 = { ...f.appSource, origin: { kind: 'plugin', pluginId: 'apps', localId: 'apps',
      suppliers: [], contributor: { occurrenceId: 'current-occurrence', pluginVersion: '1' } } };
    const result = await checkRegistryAppUpdatesV1({ http: f.http }, {
      environments: ['stale', 'replaced'].map(environmentId => ({ environmentId, expectedRevision: 3 })),
      readEnvironment: async environmentId => ({ environment: { id: environmentId, revision: environmentId === 'stale' ? 4 : 3 },
        content: { definition, template: { templateRef, definition } } }), readSources: async () => [appSource],
    });
    expect(result.results).toHaveLength(2);
    expect(result.results.find(item => item.key === 'stale')?.upstream.state).toBe('unchecked');
    expect(result.results.find(item => item.key === 'replaced')?.upstream).toMatchObject({ state: 'current', latest: f.provenance.ref });
    expect(f.calls.some(call => call.url.includes('/commits/'))).toBe(true);
    const edited = await checkRegistryAppUpdatesV1({ http: f.http }, {
      environments: [{ environmentId: 'edited', expectedRevision: 3 }],
      readEnvironment: async id => ({ environment: { id, revision: 3 }, content: {
        definition: { ...definition, contentRevision: 4 }, template: { templateRef, definition } } }),
      readSources: async () => [f.appSource],
    });
    expect(edited.results[0]?.upstream.state).toBe('current');
  });

  it('projects the strict unchecked result for schema consumers without admitting a successful source reason', () => {
    expect(() => z.toJSONSchema(RegistryUpdateCheckResultV1Schema)).not.toThrow();
    const result = { checkedAt: 1, results: [{ kind: 'skill', key: 'item', upstream: { state: 'unchecked', reason: { state: 'rate_limited' } } }] };
    expect(RegistryUpdateCheckResultV1Schema.parse(result)).toEqual(result);
    expect(RegistryUpdateCheckResultV1Schema.safeParse({ ...result, results: [{ ...result.results[0],
      upstream: { state: 'unchecked', reason: { state: 'ok', fetchedAt: 1 } } }] }).success).toBe(false);
  });

  it('compares content identity and registry version strings without guessing semver ordering', () => {
    const current: RegistryContentRefV1 = { kind: 'gitTree', repo: source.url, path: 'skills/review', commit, treeSha: 'subtree' };
    expect(compareRegistryContentRefV1(current, { ...current, commit: next })).toBe('current');
    expect(compareRegistryContentRefV1(current, { ...current, treeSha: 'changed' })).toBe('update_available');
    expect(compareRegistryContentRefV1(current, 'removed')).toBe('removed_from_source');
    expect(compareRegistryContentRefV1({ kind: 'version', version: '2026.10' }, { kind: 'version', version: '2026.9' })).toBe('update_available');
    expect(compareRegistryContentRefV1({ kind: 'version', version: 'v1' }, { kind: 'version', version: 'v1' })).toBe('current');
    expect(registryUpstreamEqualV1({ state: 'current', latest: current }, { latest: { ...current }, state: 'current' })).toBe(true);
    expect(registryUpstreamEqualV1({ state: 'current', latest: current }, { state: 'current', latest: { ...current, commit: next } })).toBe(false);
    expect(registryUpstreamEqualV1(undefined, { state: 'current' })).toBe(false);
  });

  it('compares selected app content digests and strict observation identity', () => {
    const current: RegistryContentRefV1 = { kind: 'content', digest: `sha256:${'1'.repeat(64)}` };
    const changed: RegistryContentRefV1 = { kind: 'content', digest: `sha256:${'2'.repeat(64)}` };
    const observation = { state: 'current' as const, latest: current };
    expect(compareRegistryContentRefV1(current, { ...current })).toBe('current');
    expect(registryUpstreamEqualV1(observation, { ...observation, latest: { ...current } })).toBe(true);
    expect(compareRegistryContentRefV1(current, changed)).toBe('update_available');
    expect(registryUpstreamEqualV1(observation, { state: 'update_available', latest: changed })).toBe(false);
    expect(registryUpstreamEqualV1(observation, { ...observation, latest: changed })).toBe(false);
    expect(compareRegistryContentRefV1(current, 'removed')).toBe('removed_from_source');
    expect(compareRegistryContentRefV1(current, { kind: 'version', version: current.digest })).toBe('update_available');
    expect(RegistryUpdateCheckResultV1Schema.parse({ checkedAt: 1, results: [{ kind: 'app', key: 'environment', upstream: observation }] }))
      .toEqual({ checkedAt: 1, results: [{ kind: 'app', key: 'environment', upstream: observation }] });
  });

  it('checks the configured branch once and skips the tree when the imported commit is still current', async () => {
    const f = fixture(), provenance = await imported(f.http); f.calls.length = 0;
    const result = await checkRegistryUpstreamV1({ http: f.http }, { sources: [source], items: [
      { key: 'first', provenance }, { key: 'second', provenance },
    ] });
    expect(result.get('first')).toEqual({ state: 'current', latest: provenance.ref });
    expect(result.get('second')).toEqual(result.get('first'));
    expect(f.calls).toEqual([{ url: 'https://api.github.com/repos/a/b/commits/release', sourceId: source.id, token: 'private-token' }]);
  });

  it('checks only the selected app pointers and distinguishes unchanged content, changes and removal without body reads', async () => {
    const f = await appFixture();
    const sources = [f.appSource, ...Array.from({ length: 1000 }, (_, i) => ({ ...source, id: `unrelated-${i}` }))];
    const check = () => checkRegistryUpstreamV1({ http: f.http }, { sources, items: [{ key: 'environment', provenance: f.provenance }] });
    expect((await check()).get('environment')).toMatchObject({ state: 'current' });
    expect(f.calls).toHaveLength(3);
    expect(f.calls.every(call => call.method === 'json' && call.url.includes('/example/apps/'))).toBe(true);
    f.calls.length = 0;
    f.move('services:\n  web:\n    image: nginx:1\n');
    expect((await check()).get('environment')).toMatchObject({ state: 'current', latest: { kind: 'gitTree', commit: next } });
    f.move('services:\n  web:\n    image: nginx:2\n');
    expect((await check()).get('environment')).toMatchObject({ state: 'update_available', latest: { kind: 'gitTree', commit: next } });
    f.remove();
    expect((await check()).get('environment')).toEqual({ state: 'removed_from_source' });
    f.ignore();
    expect((await check()).get('environment')).toEqual({ state: 'removed_from_source' });
    expect(f.calls.every(call => call.method === 'json' && call.url.includes('/example/apps/'))).toBe(true);
  });

  it('keeps disabled, retired and failed app sources unchecked instead of claiming current or removal', async () => {
    const f = await appFixture();
    const items = [{ key: 'environment', provenance: f.provenance }];
    for (const sources of [[], [{ ...f.appSource, enabled: false }]]) {
      expect((await checkRegistryUpstreamV1({ http: f.http }, { sources, items })).get('environment'))
        .toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
    }
    expect(f.calls).toEqual([]);
    for (const state of ['auth_failed', 'unreachable'] as const) {
      f.fail({ state });
      expect((await checkRegistryUpstreamV1({ http: f.http }, { sources: [f.appSource], items })).get('environment'))
        .toEqual({ state: 'unchecked', reason: { state } });
    }
    expect(f.calls.every(call => call.method === 'json')).toBe(true);
  });

  it('checks exact HTTP app demand by selected raw content without decoding or fetching unrelated bodies', async () => {
    const appSource: RegistrySourceDescriptorV1 = { ...source, id: 'http-apps', format: 'coolify-templates', kinds: ['app'],
      url: 'https://apps.example/service-templates.json', path: undefined, ref: undefined };
    let body = 'services:\n  web:\n    image: nginx:1\n';
    let present = true;
    let bodyFailure: Exclude<RegistrySourceStatusV1, { state: 'ok' }> | undefined;
    const calls: { method: 'json' | 'text'; url: string }[] = [];
    const http: RegistryHttpV1 = {
      getJson: async (url, options) => {
        calls.push({ method: 'json', url });
        expect(url).toBe(appSource.url);
        expect(options?.source?.token).toEqual(appSource.token);
        return { ok: true, fetchedAt: 1, value: {
          ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`unrelated-${i}`, { compose: 'invalid-base64' }])),
          ...(present ? { web: { slogan: 'Web app', compose: 'invalid-base64' } } : {}),
        } };
      },
      getText: async (url, options) => {
        calls.push({ method: 'text', url });
        expect(url).toBe('https://apps.example/compose/web.yaml');
        expect(options?.source?.token).toEqual(appSource.token);
        return bodyFailure ? { ok: false, status: bodyFailure } : { ok: true, fetchedAt: 1, value: body };
      },
      getBytes: async () => { throw new Error('Updates fetched image or body bytes'); },
    };
    const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [appSource] });
    const selected = await host.fetchRequest({ op: 'read', sourceId: appSource.id, kind: 'app', itemId: 'web' });
    if (selected.op !== 'read' || selected.item.payload.kind !== 'app' || selected.item.payload.state !== 'ready') throw new Error('Expected admitted HTTP app');
    const templateRef = { sourceId: appSource.id, itemId: 'web', version: selected.item.summary.version!, ref: selected.item.payload.ref };
    const check = async () => {
      calls.length = 0;
      return checkRegistryAppUpdatesV1({ http }, {
        environments: ['first', 'second'].map(environmentId => ({ environmentId, expectedRevision: 3 })),
        readEnvironment: async id => ({ environment: { id, revision: 3 }, content: { template: { templateRef } } }),
        readSources: async () => [appSource, ...Array.from({ length: 1000 }, (_, i) => ({ ...source, id: `unrelated-${i}` }))],
      });
    };
    const current = await check();
    expect(current.results.map(result => result.upstream)).toEqual([
      { state: 'current', latest: templateRef.ref }, { state: 'current', latest: templateRef.ref },
    ]);
    expect(calls).toEqual([{ method: 'json', url: appSource.url }, { method: 'text', url: 'https://apps.example/compose/web.yaml' }]);
    // A finite check compares raw bytes, without trying to normalize a newly
    // authored body before the person selects and reviews that replacement.
    body = 'services: [';
    expect((await check()).results.every(result => result.upstream.state === 'update_available')).toBe(true);
    expect(calls).toHaveLength(2);
    bodyFailure = { state: 'auth_failed' };
    expect((await check()).results.map(result => result.upstream)).toEqual([
      { state: 'unchecked', reason: bodyFailure }, { state: 'unchecked', reason: bodyFailure },
    ]);
    expect(calls).toHaveLength(2);
    present = false;
    expect((await check()).results.map(result => result.upstream)).toEqual([
      { state: 'removed_from_source' }, { state: 'removed_from_source' },
    ]);
    expect(calls).toEqual([{ method: 'json', url: appSource.url }]);
  });

  it('checks inline app content from one acquisition without admitting malformed unrelated descriptors', async () => {
    const appSource: RegistrySourceDescriptorV1 = { ...source, id: 'inline-apps', format: 'happier-catalog', kinds: ['app'],
      url: 'https://apps.example/catalog.json' };
    const app = normalizeComposeTemplateV1({ document: 'services:\n  web:\n    image: nginx:1\n', title: 'Web' }).app;
    const catalog: { schemaVersion: number; apps: unknown[] } = { schemaVersion: 1, apps: [{ itemId: 'web', app }, ...Array.from({ length: 1000 }, (_, i) => ({
      itemId: `unrelated-${i}`, app: { notAnApp: true },
    }))] };
    let requests = 0;
    const http: RegistryHttpV1 = { getJson: async (url, options) => {
      ++requests;
      expect(url).toBe(appSource.url); expect(options?.source?.token).toEqual(appSource.token);
      return { ok: true, value: catalog, fetchedAt: 1 };
    }, getText: async () => { throw new Error('Unexpected app body fanout'); }, getBytes: async () => { throw new Error('Unexpected image read'); } };
    const selected = RegistryItemV1Schema.parse(await happierCatalogRegistryAdapterV1.read({ http }, { source: appSource, kind: 'app', itemId: 'web' }));
    if (selected.payload.kind !== 'app') throw new Error('Expected app');
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: appSource.id, sourceUrl: appSource.url, format: appSource.format,
      itemId: 'web', ref: selected.payload.ref, importedAt: 1 });
    const check = async () => {
      requests = 0;
      const result = await checkRegistryUpstreamV1({ http }, { sources: [appSource], items: [{ key: 'environment', provenance }] });
      expect(requests).toBe(1);
      return result.get('environment');
    };
    expect(await check()).toMatchObject({ state: 'current', latest: selected.payload.ref });
    catalog.apps[0] = { itemId: 'web', app: { ...app, title: 'Changed' } };
    expect(await check()).toMatchObject({ state: 'update_available', latest: { kind: 'content' } });
    catalog.apps.shift();
    expect(await check()).toEqual({ state: 'removed_from_source' });
    catalog.apps.unshift({ itemId: 'web', app, unexpected: true });
    expect(await check()).toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
    const review = RegistryItemV1Schema.parse(await happierCatalogRegistryAdapterV1.read({ http }, { source: appSource, kind: 'app', itemId: 'web' }));
    expect(review.payload).toMatchObject({ kind: 'app', state: 'needs_review', ref: { kind: 'content' } });
    expect(review.payload).not.toHaveProperty('app');
    catalog.apps[0] = { itemId: 'web', app: { notAnApp: true } };
    expect(await check()).toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
    catalog.apps[0] = { itemId: 'web', app };
    catalog.apps.push({ itemId: 'web', app });
    expect(await check()).toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
    catalog.apps.pop();
    const mixed = await checkRegistryUpstreamV1({ http }, { sources: [appSource], items: [
      { key: 'healthy', provenance }, { key: 'malformed', provenance: { ...provenance, itemId: 'unrelated-0' } },
    ] });
    expect(mixed.get('healthy')).toMatchObject({ state: 'current' });
    expect(mixed.get('malformed')).toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
  });

  it('compares package pins by content and package identity across supplier reloads', () => {
    const packageContent = { pluginId: 'com.example.apps', pluginVersion: '1.0.0', occurrenceId: 'occurrence-1', path: 'apps/catalog.json' };
    const ref: RegistryContentRefV1 = { kind: 'packageContent', ...packageContent, digest: `sha256:${'1'.repeat(64)}` };
    expect(compareRegistryContentRefV1(ref, { ...ref })).toBe('current');
    expect(registryUpstreamEqualV1({ state: 'current', latest: ref }, { state: 'current', latest: { ...ref } })).toBe(true);
    expect(compareRegistryContentRefV1(ref, { ...ref, digest: `sha256:${'2'.repeat(64)}` })).toBe('update_available');
    expect(compareRegistryContentRefV1(ref, { ...ref, occurrenceId: 'replacement' })).toBe('current');
    expect(registryUpstreamEqualV1({ state: 'current', latest: ref }, { state: 'current', latest: { ...ref, occurrenceId: 'replacement' } })).toBe(true);
    for (const changed of [{ ...ref, pluginId: 'other.apps' }, { ...ref, pluginVersion: '2.0.0' },
      { ...ref, path: 'other/catalog.json' }, { ...ref, digest: `sha256:${'2'.repeat(64)}` }]) {
      expect(compareRegistryContentRefV1(ref, changed)).toBe('update_available');
      expect(registryUpstreamEqualV1({ state: 'current', latest: ref }, { state: 'current', latest: changed })).toBe(false);
    }
  });

  it('declines changed package source identity before fetching', async () => {
    const packageContent = { pluginId: 'com.example.apps', pluginVersion: '1.0.0', occurrenceId: 'occurrence-1', path: 'apps/catalog.json' };
    const ref: RegistryContentRefV1 = { kind: 'packageContent', ...packageContent, digest: `sha256:${'1'.repeat(64)}` };
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: 'com.example.apps/catalog', format: 'happier-catalog',
      itemId: 'web', ref, importedAt: 1 });
    const appSource: RegistrySourceDescriptorV1 = { id: provenance.sourceId, title: 'Apps', format: 'happier-catalog', kinds: ['app'],
      packageContent, enabled: true, addedAt: 0, removable: false,
      origin: { kind: 'plugin', pluginId: packageContent.pluginId, localId: 'catalog', suppliers: ['machine'] } };
    let requests = 0;
    const unexpected = async (): Promise<never> => { ++requests; throw new Error('Replaced package authority must not fetch'); };
    const http: RegistryHttpV1 = { getJson: unexpected, getText: unexpected, getBytes: unexpected };
    for (const replacement of [{ ...packageContent, pluginId: 'other.apps' },
      { ...packageContent, path: 'other/catalog.json' }]) {
      expect((await checkRegistryUpstreamV1({ http }, { sources: [{ ...appSource, packageContent: replacement }],
        items: [{ key: 'environment', provenance }] })).get('environment'))
        .toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
    }
    expect(requests).toBe(0);
  });

  it('checks package observations through the admitted package reader with no HTTP or sibling descriptor reads', async () => {
    const source = RegistryPackagedSourceDescriptorV1Schema.parse({ id: 'com.example.apps/catalog', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
      packageContent: { pluginId: 'com.example.apps', pluginVersion: '1.0.0', occurrenceId: 'occurrence-1', path: 'apps/catalog.json' },
      enabled: true, addedAt: 0, removable: false,
      origin: { kind: 'plugin', pluginId: 'com.example.apps', localId: 'catalog', suppliers: ['machine'] } });
    const app = normalizeComposeTemplateV1({ document: 'services:\n  web:\n    image: nginx:1\n', title: 'Web' }).app;
    const catalog: { schemaVersion: number; apps: unknown[] } = { schemaVersion: 1,
      apps: [{ itemId: 'web', app }, { itemId: 'broken', app: { notAnApp: true } }] };
    let reads = 0;
    const unexpected = async (): Promise<never> => { throw new Error('Package updates must not fetch HTTP'); };
    const http: RegistryHttpV1 = { getJson: unexpected, getText: unexpected, getBytes: unexpected };
    const packageContent = { read: async () => { ++reads; return { text: JSON.stringify(catalog), fetchedAt: 1 }; } };
    const host = createRegistryHostV1({ host: 'node', http, packageContent, readSources: async () => [source] });
    const selected = await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'web', version: '1.0.0' });
    if (selected.op !== 'read' || selected.item.payload.kind !== 'app') throw new Error('Expected packaged app');
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: source.id, format: source.format, itemId: 'web',
      ref: selected.item.payload.ref, importedAt: 1 });
    const check = async () => {
      reads = 0;
      const result = await checkRegistryUpstreamV1({ http, packageContent }, { sources: [source], items: [{ key: 'environment', provenance }] });
      expect(reads).toBe(1);
      return result.get('environment');
    };
    expect(await check()).toMatchObject({ state: 'current', latest: selected.item.payload.ref });
    source.packageContent = { ...source.packageContent, occurrenceId: 'replacement' };
    expect(await check()).toMatchObject({ state: 'current', latest: { occurrenceId: 'replacement' } });
    source.packageContent = { ...source.packageContent, pluginVersion: '2.0.0' };
    expect(await check()).toMatchObject({ state: 'update_available', latest: { pluginVersion: '2.0.0' } });
    source.packageContent = { ...source.packageContent, pluginVersion: '1.0.0' };
    catalog.apps[0] = { itemId: 'web', app: { ...app, title: 'Changed' } };
    expect(await check()).toMatchObject({ state: 'update_available', latest: { kind: 'packageContent', pluginVersion: '1.0.0' } });
    catalog.apps.shift();
    expect(await check()).toEqual({ state: 'removed_from_source' });
    expect((await checkRegistryUpstreamV1({ http }, { sources: [source], items: [{ key: 'environment', provenance }] })).get('environment'))
      .toEqual({ state: 'unchecked', reason: { state: 'needs_machine' } });
  });

  it('compares the imported subtree on a changed commit, and treats a missing SKILL.md as removal', async () => {
    const f = fixture(), provenance = await imported(f.http);
    const check = () => checkRegistryUpstreamV1({ http: f.http }, { sources: [source], items: [{ key: 'item', provenance }] });
    f.move(next, 'subtree');
    expect((await check()).get('item')).toMatchObject({ state: 'current', latest: { commit: next, treeSha: 'subtree' } });
    f.move(next, 'changed');
    expect((await check()).get('item')).toMatchObject({ state: 'update_available', latest: { treeSha: 'changed' } });
    f.move(next, null);
    expect((await check()).get('item')).toEqual({ state: 'removed_from_source' });
    const withoutSkill: RegistryHttpV1 = { ...f.http, getJson: async url => ({ ok: true, fetchedAt: 2,
      value: url.includes('/commits/') ? { sha: next } : { sha: 'root', tree: [{ path: 'skills/review', type: 'tree', mode: '040000', sha: 'changed' }] } }) };
    expect((await checkRegistryUpstreamV1({ http: withoutSkill }, { sources: [source], items: [{ key: 'item', provenance }] })).get('item'))
      .toEqual({ state: 'removed_from_source' });
  });

  it('keeps a failed or disabled source unchecked while another source succeeds', async () => {
    const f = fixture(), provenance = await imported(f.http);
    const healthy = { ...source, id: 'healthy', url: 'https://github.com/a/healthy' };
    const rateLimited: RegistryHttpV1 = { ...f.http, getJson: async (url, opts) => url.includes('/a/b/')
      ? { ok: false, status: { state: 'rate_limited', retryAt: 1000 } } : f.http.getJson(url, opts) };
    const result = await checkRegistryUpstreamV1({ http: rateLimited }, { sources: [source, healthy], items: [
      { key: 'limited', provenance }, { key: 'healthy', provenance: { ...provenance, sourceId: healthy.id, sourceUrl: healthy.url,
        ref: { ...provenance.ref, repo: healthy.url } } },
    ] });
    expect(result.get('limited')).toEqual({ state: 'unchecked', reason: { state: 'rate_limited', retryAt: 1000 } });
    expect(result.get('healthy')).toMatchObject({ state: 'current' });
    expect((await checkRegistryUpstreamV1({ http: f.http }, { sources: [{ ...source, enabled: false }],
      items: [{ key: 'disabled', provenance }] })).get('disabled')).toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
  });

  it('does not convert cancellation into an unchecked result', async () => {
    const f = fixture(), provenance = await imported(f.http), controller = new AbortController();
    const reason = new TypeError('Account retired');
    const cancelled: RegistryHttpV1 = { ...f.http, getJson: async () => { controller.abort(reason); throw reason; } };
    await expect(checkRegistryUpstreamV1({ http: cancelled, signal: controller.signal }, {
      sources: [source], items: [{ key: 'item', provenance }],
    })).rejects.toBe(reason);
  });

  it('batches an ACP index with its source credential binding and treats only absent ids as removed', async () => {
    const acp: RegistrySourceDescriptorV1 = { ...source, id: 'private-acp', format: 'acp-registry', kinds: ['agent'],
      url: 'https://acp.example/registry.json' };
    const requests: string[] = [];
    const unused = async (): Promise<never> => { throw new Error('Unexpected HTTP request'); };
    const http: RegistryHttpV1 = { getJson: async (url, opts) => {
      requests.push(url); expect(opts?.source?.token).toEqual(acp.token);
      return { ok: true, fetchedAt: 1, value: ACP_REGISTRY_V1_FIXTURE };
    }, getText: unused, getBytes: unused };
    const item = await acpRegistryAdapterV1.read({ http }, { source: acp, kind: 'agent', itemId: 'goose' });
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: acp.id, sourceUrl: acp.url, format: acp.format,
      itemId: 'goose', ref: { kind: 'version', version: item.summary.version }, importedAt: item.fetchedAt });
    requests.length = 0;
    const result = await checkRegistryUpstreamV1({ http }, { sources: [acp], items: [
      { key: 'goose', provenance }, { key: 'gone', provenance: { ...provenance, itemId: 'gone' } },
    ] });
    expect(result.get('goose')).toEqual({ state: 'current', latest: provenance.ref });
    expect(result.get('gone')).toEqual({ state: 'removed_from_source' });
    expect(requests).toEqual([acp.url]);
  });

  it('retains the source branch and token receiver when skills.sh resolves a GitHub repository', async () => {
    const f = fixture(), original = await imported(f.http); f.calls.length = 0;
    const skillsSh: RegistrySourceDescriptorV1 = { ...source, format: 'skills-sh', url: 'https://skills.sh', path: undefined };
    const provenance = { ...original, format: skillsSh.format, sourceUrl: skillsSh.url, itemId: 'a/b/review' };
    expect((await checkRegistryUpstreamV1({ http: f.http }, { sources: [skillsSh], items: [{ key: 'skill', provenance }] })).get('skill'))
      .toMatchObject({ state: 'current' });
    expect(f.calls).toEqual([{ url: 'https://api.github.com/repos/a/b/commits/release', sourceId: source.id, token: 'private-token' }]);
  });

  it('resolves a marketplace plugin branch while retaining the catalog token receiver', async () => {
    const market: RegistrySourceDescriptorV1 = { ...source, url: 'https://github.com/a/catalog', format: 'claude-marketplace', path: undefined, ref: 'catalog-main' };
    const calls: { url: string; credentialUrl?: string }[] = [];
    const unused = async (): Promise<never> => { throw new Error('Unexpected HTTP request'); };
    const http: RegistryHttpV1 = { getJson: async (url, opts) => {
      calls.push({ url, credentialUrl: opts?.source?.url });
      return { ok: true, fetchedAt: 1, value: url.endsWith('/marketplace.json')
        ? { plugins: [{ name: 'remote', source: { source: 'github', repo: 'a/skills', ref: 'stable' } }] }
        : url.endsWith('/plugin.json') ? {} : url.includes('/commits/') ? { sha: commit }
          : { sha: 'root', tree: [{ path: 'skills/review', type: 'tree', mode: '040000', sha: 'subtree' },
            { path: 'skills/review/SKILL.md', type: 'blob', mode: '100644', sha: 'blob', size: 1 }] } };
    }, getText: async () => ({ ok: true, fetchedAt: 1, value: '# Review\n' }), getBytes: unused };
    const item = await claudeMarketplaceRegistryAdapterV1.read({ http }, { source: market, kind: 'skill', itemId: 'remote/skills/review' });
    const provenance = RegistryProvenanceV1Schema.parse({ sourceId: market.id, sourceUrl: market.url, format: market.format,
      itemId: item.summary.itemId, ref: item.payload.skill.ref, importedAt: item.fetchedAt });
    calls.length = 0;
    expect((await checkRegistryUpstreamV1({ http }, { sources: [market], items: [{ key: 'skill', provenance }] })).get('skill')).toMatchObject({ state: 'current' });
    expect(calls.map(call => call.url)).toEqual(['https://raw.githubusercontent.com/a/catalog/catalog-main/.claude-plugin/marketplace.json',
      'https://api.github.com/repos/a/skills/commits/stable']);
    expect(calls.every(call => call.credentialUrl === market.url)).toBe(true);
  });

  it.each([{ plugins: 'invalid envelope' }, { plugins: [{ name: 'remote' }] }])('keeps malformed marketplace declarations unchecked rather than removed', async body => {
    const f = fixture(), original = await imported(f.http);
    const market: RegistrySourceDescriptorV1 = { ...source, format: 'claude-marketplace', url: 'https://github.com/a/catalog' };
    const provenance = RegistryProvenanceV1Schema.parse({ ...original, sourceUrl: market.url, format: market.format, itemId: 'remote/skills/review' });
    const http: RegistryHttpV1 = { ...f.http, getJson: async () => ({ ok: true, fetchedAt: 1, value: body }) };
    expect((await checkRegistryUpstreamV1({ http }, { sources: [market], items: [{ key: 'skill', provenance }] })).get('skill'))
      .toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
  });
});
