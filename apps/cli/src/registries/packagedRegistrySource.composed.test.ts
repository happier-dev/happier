import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';
import { readIndexedBundledDeclarationManifest } from '../plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type DeploymentTemplateV1 } from '@happier-dev/plugin-sdk';
import { createAuthoredAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';
import { projectPluginRegistrySourceDeclarationV1, createPluginRegistrySourceDescriptorV1, createRegistryHostV1 } from '@happier-dev/protocol/registries';
import { createCliRegistryHostV1 } from './createCliRegistryHost';
import { createRegistryHttpV1 } from './registryHttp';
import { publishAccountRegistrySourcesFixture } from '@/plugins/testkit/accountRegistrySources';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

describe('installed packaged app registry sources', () => {
  afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); });
  it('reads inert external package data through the production host and withdraws a retired occurrence', async () => {
    const pluginId = 'com.acme.packaged-apps';
    const authored = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Packaged apps', registrySources: {
      apps: { title: 'Apps', format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' } },
      remote: { title: 'Remote apps', format: 'happier-catalog', kinds: ['app'], url: 'https://catalog.example/apps.json' },
    } });
    const app = { schemaVersion: 1, title: 'Postgres', compose: { document: 'services:\n  db:\n    image: postgres:17\n', profiles: [], services: [] },
      variables: [], generatedSecrets: [], domains: [], volumes: [] } satisfies DeploymentTemplateV1;
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: authored.manifest,
      files: { 'resources/apps.json': JSON.stringify({ schemaVersion: 1, apps: [{ itemId: 'postgres', app }] }) } }], coldStart: true });
    try {
      const entry = runtime.registry.contributes.registrySources?.find(entry => entry.pluginId === pluginId);
      expect(entry).toBeDefined();
      const occurrenceId = runtime.registry.contributes.occurrenceIdsByPluginId?.[pluginId];
      expect(occurrenceId).toBeTruthy();
      const projected = projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: entry!.definition });
      const source = createPluginRegistrySourceDescriptorV1({ ...projected, occurrenceId, suppliers: [] });
      const cli = createCliRegistryHostV1({ pluginRuntime: runtime.controller });
      publishAccountRegistrySourcesFixture();
      const remoteSourceId = `${pluginId}/remote`;
      expect((await cli.readSources()).find(candidate => candidate.id === remoteSourceId)?.origin).toMatchObject({
        kind: 'plugin', contributor: { pluginVersion: '1.0.0', occurrenceId },
      });
      const remoteHost = createRegistryHostV1({ host: 'node', readSources: cli.readSources,
        http: createRegistryHttpV1({ fetch: async () => Response.json({ schemaVersion: 1, apps: [{ itemId: 'postgres', app }] }) }) });
      expect(await remoteHost.fetchRequest({ op: 'read', sourceId: remoteSourceId, kind: 'app', itemId: 'postgres' }))
        .toMatchObject({ op: 'read', item: { payload: { kind: 'app', state: 'ready', app } } });
      // Use the production package transport beneath the same public host, without Account storage or HTTP.
      const host = createRegistryHostV1({ host: 'node', ...cli.fetchContext, readSources: async () => [source] });
      expect(await host.fetchRequest({ op: 'list', sourceId: source.id, kind: 'app' })).toMatchObject({ op: 'list',
        page: { items: [{ itemId: 'postgres', title: 'Postgres' }] } });
      const selected = await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'postgres', version: '1.0.0' });
      expect(selected).toMatchObject({ op: 'read', item: { payload: { kind: 'app', app,
        ref: { kind: 'packageContent', pluginId, pluginVersion: '1.0.0', occurrenceId, path: 'resources/apps.json' } } } });
      await retireAdmittedPluginRuntimeRegistry({ controller: runtime.controller, registry: runtime.registry, happyHomeDir: runtime.happyHomeDir,
        generationAuthority: runtime.committed });
      expect((await cli.readSources()).find(candidate => candidate.id === remoteSourceId)?.origin ?? {}).not.toHaveProperty('contributor');
      expect(await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'app', itemId: 'postgres', version: '1.0.0' }))
        .toEqual({ op: 'error', status: { state: 'invalid_source' } });
    } finally { await runtime.dispose(); }
  });
});

it('resolves the shipped starter source for a fresh Account through the daemon registry owner', async () => {
  const { readFile } = await import('node:fs/promises');
  const shipped = PluginManifestV2LoadSchema.parse(readIndexedBundledDeclarationManifest(new URL('../../assets/bundled-plugin-manifests/deployment-templates.json', import.meta.url)));
  const text = await readFile(new URL('../../../../packages/plugins/deployment-templates/resources/registry/starters.json', import.meta.url), 'utf8');
  // Only inert source declarations are consumed; this fixture has no author module.
  const { entrypoints: _entrypoints, ...manifest } = shipped;
  const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest,
    files: { 'resources/registry/starters.json': text } }], coldStart: true });
  try {
    publishAccountRegistrySourcesFixture();
    const cli = createCliRegistryHostV1({ pluginRuntime: runtime.controller });
    const sourceId = shipped.id + '/starters';
    const sources = await cli.readSources();
    expect(sources).toContainEqual(expect.objectContaining({ id: sourceId, kinds: ['starter'],
      packageContent: expect.objectContaining({ path: 'resources/registry/starters.json' }) }));
    expect(sources.filter(source => source.enabled && source.kinds.includes('starter')).map(source => source.id)).toEqual([sourceId]);
    const host = createRegistryHostV1({ host: 'node', ...cli.fetchContext, readSources: cli.readSources });
    expect(await host.fetchRequest({ op: 'list', sourceId, kind: 'starter' })).toMatchObject({ op: 'list',
      page: { status: { state: 'ok' }, items: expect.arrayContaining([expect.objectContaining({ itemId: 'static-website' })]) } });
    expect(await host.fetchRequest({ op: 'read', sourceId, kind: 'starter', itemId: 'static-website' })).toMatchObject({ op: 'read',
      item: { payload: { kind: 'starter', ref: { kind: 'packageContent', pluginId: shipped.id } } } });
  } finally { await runtime.dispose(); resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); }
});
