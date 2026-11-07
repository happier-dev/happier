import { describe, expect, it } from 'vitest';
import { PluginRegistrySourceContributionV1Schema } from '../plugins/contributions/registrySources.js';
import { createPluginRegistrySourceDescriptorV1 } from './registryPluginSourcesV1.js';
import { RegistrySourceDescriptorV1Schema } from './registrySourcesV1.js';
import { createRegistryHostV1 } from './registryHostV1.js';

describe('plugin app registry declarations', () => {
  it('retains only proven remote app contributor version and occurrence pairs', () => {
    const definition = PluginRegistrySourceContributionV1Schema.parse({ id: 'apps', title: 'Apps',
      format: 'happier-catalog', kinds: ['app'], url: 'https://catalog.example/apps.json' });
    const create = (proof: Readonly<{ pluginVersion?: string; occurrenceId?: string }>) =>
      createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.apps', definition, suppliers: ['machine-a'], ...proof });
    const active = create({ pluginVersion: '1.0.0', occurrenceId: 'opaque-current-occurrence' });
    expect(active.origin).toMatchObject({ kind: 'plugin', contributor: {
      pluginVersion: '1.0.0', occurrenceId: 'opaque-current-occurrence',
    } });
    expect(RegistrySourceDescriptorV1Schema.parse(active)).toEqual(active);
    for (const proof of [{}, { pluginVersion: '1.0.0' }, { occurrenceId: 'opaque-current-occurrence' }]) {
      expect(create(proof).origin).not.toHaveProperty('contributor');
    }
    expect(createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.apps', pluginVersion: '1.0.0',
      occurrenceId: 'opaque-current-occurrence', suppliers: [],
      definition: PluginRegistrySourceContributionV1Schema.parse({ ...definition, kinds: ['plugin'] }) }).origin)
      .not.toHaveProperty('contributor');
    expect(RegistrySourceDescriptorV1Schema.safeParse({ ...active, origin: { ...active.origin,
      contributor: { pluginVersion: '1.0.0' } } }).success).toBe(false);
  });
  it('projects inert package content with the current occurrence and no fabricated URL', () => {
    const definition = PluginRegistrySourceContributionV1Schema.parse({ id: 'apps', title: 'Apps',
      format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' } });
    const descriptor = createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.apps', pluginVersion: '1.0.0',
      occurrenceId: 'com.acme.apps:7', definition, suppliers: ['machine-a'] });
    expect(RegistrySourceDescriptorV1Schema.parse(descriptor)).toEqual({ id: 'com.acme.apps/apps', title: 'Apps',
      format: 'happier-catalog', kinds: ['app'], enabled: true, addedAt: 0, removable: false,
      packageContent: { pluginId: 'com.acme.apps', pluginVersion: '1.0.0', occurrenceId: 'com.acme.apps:7', path: 'resources/apps.json' },
      origin: { kind: 'plugin', pluginId: 'com.acme.apps', localId: 'apps', suppliers: ['machine-a'] } });
    for (const extra of [{ url: 'https://mirror.example/apps.json' }, { ref: 'main' }, { kinds: ['skill'] },
      { packageContent: { path: '../apps.json' } }, { packageContent: { path: '/apps.json' } },
      { packageContent: { path: 'resources/apps.json', resolve: 'callback' } }]) {
      expect(PluginRegistrySourceContributionV1Schema.safeParse({ ...definition, ...extra }).success).toBe(false);
    }
    expect(() => createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.apps', definition, suppliers: [] })).toThrow();
  });
  it('routes package data to its daemon supplier without exposing it to an HTTP reader', async () => {
    const definition = PluginRegistrySourceContributionV1Schema.parse({ id: 'apps', title: 'Apps',
      format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' } });
    const source = createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.apps', pluginVersion: '1.0.0',
      occurrenceId: 'com.acme.apps:7', definition, suppliers: ['machine-a'] });
    let httpReads = 0;
    let daemonReads = 0;
    const http = { getJson: async () => { httpReads++; throw new Error('Packaged data must not use HTTP'); },
      getText: async () => { httpReads++; throw new Error('Packaged data must not use HTTP'); },
      getBytes: async () => { httpReads++; throw new Error('Packaged data must not use HTTP'); } };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => [source], daemonFetch: async request => {
      daemonReads++;
      expect(request).toEqual({ op: 'list', sourceId: source.id, kind: 'app' });
      return { op: 'list', page: { sourceId: source.id, items: [], nextCursor: null, status: { state: 'ok', fetchedAt: 1 } } };
    } });
    expect(await host.fetchRequest({ op: 'list', sourceId: source.id, kind: 'app' })).toMatchObject({ op: 'list' });
    expect(httpReads).toBe(0);
    expect(daemonReads).toBe(1);
  });
  it('lists inert package summaries and reads only the selected strict app at its plugin version', async () => {
    const definition = PluginRegistrySourceContributionV1Schema.parse({ id: 'apps', title: 'Apps',
      format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' } });
    const source = createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.apps', pluginVersion: '1.0.0',
      occurrenceId: 'com.acme.apps:7', definition, suppliers: [] });
    const app = { schemaVersion: 1, title: 'Postgres', compose: { document: 'services:\n  db:\n    image: postgres:17\n', profiles: [], services: [] },
      variables: [], generatedSecrets: [], domains: [], volumes: [] };
    const catalog = { schemaVersion: 1, apps: [{ itemId: 'postgres', app }, { itemId: 'broken', app: { title: 'Broken', resolve: 'never run' } }] };
    let packageReads = 0;
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [source],
      http: { getJson: async () => { throw new Error('Unexpected HTTP'); }, getText: async () => { throw new Error('Unexpected HTTP'); },
        getBytes: async () => { throw new Error('Unexpected HTTP'); } },
      packageContent: { read: async () => { packageReads++; return { text: JSON.stringify(catalog), fetchedAt: 1 }; } },
    });
    expect(packageReads).toBe(0);
    expect(await host.fetchRequest({ op: 'list', sourceId: source.id, kind: 'app' })).toMatchObject({ op: 'list',
      page: { items: [{ itemId: 'postgres', title: 'Postgres' }, { itemId: 'broken', title: 'Broken' }] } });
    expect(packageReads).toBe(1);
    expect(await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'postgres', version: '1.0.0' }))
      .toMatchObject({ op: 'read', item: { summary: { version: '1.0.0' }, payload: { kind: 'app', state: 'ready', app,
        ref: { kind: 'packageContent', pluginId: 'com.acme.apps', pluginVersion: '1.0.0', occurrenceId: 'com.acme.apps:7', path: 'resources/apps.json' } } } });
    expect(await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'postgres', version: '0.9.0' }))
      .toEqual({ op: 'error', status: { state: 'invalid_source' } });
    expect(await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'broken' }))
      .toMatchObject({ op: 'read', item: { summary: { problem: { code: 'needs_review' } },
        payload: { kind: 'app', state: 'needs_review', diagnostics: expect.any(Array),
          ref: { kind: 'packageContent', pluginId: 'com.acme.apps', pluginVersion: '1.0.0' } } } });
  });
  it('admits strict app source declarations through the shared source projection', () => {
    for (const format of ['happier-catalog', 'coolify-templates', 'dokploy-templates']) {
      const definition = PluginRegistrySourceContributionV1Schema.parse({ id: 'apps', title: 'Apps',
        format, kinds: ['app'], url: 'https://catalog.example/apps.json' });
      const descriptor = createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.apps', definition,
        suppliers: ['machine-a', 'machine-a', 'machine-b'] });
      expect(RegistrySourceDescriptorV1Schema.parse(descriptor)).toMatchObject({ id: 'com.acme.apps/apps',
        kinds: ['app'], origin: { kind: 'plugin', pluginId: 'com.acme.apps', localId: 'apps', suppliers: ['machine-a', 'machine-b'] } });
      for (const extra of [{ callback: 'resolve' }, { token: { secretRef: 'secret' } },
        { url: 'https://token@catalog.example/apps.json' }, { url: 'http://catalog.example/apps.json' }]) {
        expect(PluginRegistrySourceContributionV1Schema.safeParse({ ...definition, ...extra }).success).toBe(false);
      }
      if (format !== 'happier-catalog') for (const kind of ['skill', 'plugin', 'mcpServer', 'agent']) {
        expect(PluginRegistrySourceContributionV1Schema.safeParse({ ...definition, kinds: [kind] }).success).toBe(false);
      }
    }
  });
});
