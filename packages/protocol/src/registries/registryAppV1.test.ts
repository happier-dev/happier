import { describe, expect, it } from 'vitest';
import { RegistryItemV1Schema, RegistryProvenanceV1Schema } from './registryItemsV1.js';
import { createRegistryHostV1 } from './registryHostV1.js';
import { deriveMarketplaceSourceId } from '../marketplace/marketplaceSourceRegistryV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from './registryActionsV1.js';
import { checkRegistryUpstreamV1 } from './registryUpdatesV1.js';
import type { RegistryHttpV1 } from './formats/registryFormatAdapterV1.js';
import type { RegistrySourceDescriptorV1 } from './registrySourcesV1.js';

const descriptor = {
  schemaVersion: 1, title: 'PostgreSQL',
  compose: { document: 'services:\n  db:\n    image: postgres:17\n', profiles: [], services: [] },
  variables: [{ key: 'DB_PASSWORD', label: 'Password', required: true, valueKind: 'string', secret: true, sites: [] }],
  generatedSecrets: [{ key: 'DB_PASSWORD', purpose: 'database', label: 'Database password', profile: { kind: 'base64url-32-bytes' } }],
  domains: [], volumes: [], loginFields: { password: 'DB_PASSWORD' },
};
const item = {
  summary: { sourceId: 'apps', kind: 'app', itemId: 'postgres', title: 'PostgreSQL', version: '1' },
  payload: { kind: 'app', state: 'ready', app: descriptor, ref: { kind: 'version', version: '1' } }, fetchedAt: 1,
};

describe('registry app admission', () => {
  it('keeps malformed descriptors and identifiable entry envelopes reviewable without withdrawing healthy siblings', async () => {
    const source: RegistrySourceDescriptorV1 = {
      id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'], url: 'https://catalog.example/apps.json',
      enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true,
    };
    const http: RegistryHttpV1 = {
      getJson: async () => ({ ok: true, fetchedAt: 1, value: { schemaVersion: 1, apps: [
        { itemId: 'healthy', app: descriptor }, { itemId: 'unresolved', app: { ...descriptor, generatedSecrets: [
          { ...descriptor.generatedSecrets[0], profile: { kind: 'author-code', command: 'generate' } },
        ] } },
        { itemId: 'extra-key', app: descriptor, unsupported: true }, { itemId: 'missing-app' },
      ] } }), getText: async () => { throw new Error('Unexpected body request'); }, getBytes: async () => { throw new Error('Unexpected body request'); },
    };
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [source], http });
    expect(await host.execute('registries.items.list', { kind: 'app' })).toMatchObject({
      pages: [{ status: { state: 'ok' }, items: [{ itemId: 'healthy' }, { itemId: 'unresolved' },
        { itemId: 'extra-key', problem: { code: 'needs_review', diagnostics: [expect.objectContaining({ reason: 'unrecognized_keys' })] } },
        { itemId: 'missing-app', problem: { code: 'needs_review', diagnostics: [expect.objectContaining({ field: 'app' })] } },
      ] }],
    });
    expect(await host.execute('registries.items.read', { kind: 'app', sourceId: 'apps', itemId: 'healthy' }))
      .toMatchObject({ item: { payload: { kind: 'app', app: descriptor } } });
    expect(await host.execute('registries.items.read', { kind: 'app', sourceId: 'apps', itemId: 'unresolved' }))
      .toMatchObject({ item: { summary: { problem: { code: 'needs_review', diagnostics: [
        expect.objectContaining({ field: expect.stringContaining('generatedSecrets') }),
      ] } }, payload: { kind: 'app' } } });
    const selected = await Promise.all(['healthy', 'extra-key', 'missing-app'].map(async itemId => {
      const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
        kind: 'app', sourceId: source.id, itemId,
      }));
      if (item.payload.kind !== 'app') throw new Error('Expected selected app');
      expect(item.payload.state).toBe(itemId === 'healthy' ? 'ready' : 'needs_review');
      return { key: itemId, provenance: RegistryProvenanceV1Schema.parse({ sourceId: source.id, sourceUrl: source.url,
        format: source.format, itemId, ref: item.payload.ref, importedAt: item.fetchedAt }) };
    }));
    const observations = await checkRegistryUpstreamV1({ http }, { sources: [source], items: selected });
    expect(observations.get('healthy')).toMatchObject({ state: 'current' });
    for (const itemId of ['extra-key', 'missing-app']) {
      expect(observations.get(itemId)).toEqual({ state: 'unchecked', reason: { state: 'invalid_source' } });
    }
  });

  it('browses curated app pointers without fetching their selected Compose bodies', async () => {
    const url = 'https://marketplace.happier.dev/catalog.json';
    const id = deriveMarketplaceSourceId(url);
    const requests: string[] = [];
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [{
      id, title: 'Curated apps', format: 'happier-catalog', kinds: ['app'], url, enabled: true, addedAt: 0,
      origin: { kind: 'built_in' }, removable: false,
    }], http: {
      getJson: async target => { requests.push(target); return { ok: true, fetchedAt: 1, value: {
        source: { id, title: 'Curated apps', kind: 'curated', sourceUrl: url },
        freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [],
        picks: [{ kind: 'app', format: 'coolify-templates', sourceUrl: 'https://github.com/coollabsio/coolify',
          itemId: 'uptime-kuma', display: { title: 'Uptime Kuma' } }],
      } }; }, getText: async () => { throw new Error('Unexpected body request'); }, getBytes: async () => { throw new Error('Unexpected body request'); },
    } });
    expect(await host.execute('registries.items.list', { kind: 'app' })).toMatchObject({
      pages: [{ status: { state: 'ok' }, items: [{ kind: 'app', itemId: 'uptime-kuma', title: 'Uptime Kuma' }] }],
    });
    expect(requests).toEqual([url]);
  });

  it('lists and reads a selected catalog app through the registry host without author activation', async () => {
    const source = { id: 'apps', title: 'Apps', format: 'happier-catalog' as const, kinds: ['app' as const],
      url: 'https://catalog.example/apps.json', enabled: true, addedAt: 0, origin: { kind: 'user' as const }, removable: true };
    const requests: string[] = [];
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
      getJson: async url => { requests.push(url); return { ok: true, fetchedAt: 1, value: { schemaVersion: 1, apps: [{ itemId: 'postgres', app: descriptor }] } }; },
      getText: async () => { throw new Error('Unexpected body request'); }, getBytes: async () => { throw new Error('Unexpected body request'); },
    } });
    const listed = await host.execute('registries.items.list', { kind: 'app', sourceIds: ['apps'] });
    expect(listed).toMatchObject({ pages: [{ status: { state: 'ok' }, items: [{ kind: 'app', itemId: 'postgres' }] }] });
    const selected = await host.execute('registries.items.read', { kind: 'app', sourceId: 'apps', itemId: 'postgres' });
    expect(selected).toMatchObject({ item: { payload: { kind: 'app', app: descriptor, ref: { kind: 'content' } } } });
    expect(requests).toEqual([source.url, source.url]);
  });

  it('retains one inert normalized descriptor and binds the summary to the selected pin', () => {
    expect(RegistryItemV1Schema.parse(item)).toEqual(item);
    expect(RegistryItemV1Schema.safeParse({ ...item, summary: { ...item.summary, version: 'latest' } }).success).toBe(false);
    for (const app of [{ ...descriptor, install: 'run-author-code' },
      { ...descriptor, loginFields: { password: 'literal-password' } },
      { ...descriptor, variables: [{ ...descriptor.variables[0], secret: false }] },
      { ...descriptor, generatedSecrets: [{ ...descriptor.generatedSecrets[0], command: 'generate' }] }]) {
      expect(RegistryItemV1Schema.safeParse({ ...item, payload: { ...item.payload, app } }).success).toBe(false);
    }
  });
});
