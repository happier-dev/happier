import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { RegistryHttpV1, RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { createTestNpmTarball, sriSha512 } from '@/plugins/distribution/testkit/npmTarball';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each(['happier-npm', 'happier-catalog'] as const)('cold-reads only the selected declared template through %s without executing the package', async format => {
  const { createCliRegistryBotTemplateReaderV1 } = await import('./botTemplates');
  const [{ createPluginCompatibilityProjectionV1 }, { PluginManifestV2Schema }, { createMarketplaceNpmDiscoveryProjectionV1 },
    { createRegistryHostV1 }, { BotTemplateReleaseV1Schema }] = await Promise.all([
    import('@happier-dev/protocol/plugins/availability/compatibilityProjectionV1'), import('@happier-dev/protocol/plugins/manifest'),
    import('@happier-dev/protocol/marketplace'), import('@happier-dev/protocol/registries'), import('@happier-dev/protocol/bots/templates/botTemplateV1'),
  ]);
  const { deriveMarketplaceSourceId } = await import('@happier-dev/protocol/marketplace');
  const root = await mkdtemp(join(tmpdir(), 'happier-cold-template-')); roots.push(root);
  const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '2.0.0', releasedAtMs: 1, changelog: 'Garden update',
    content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Use native plants.' },
      memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
  const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({ id: 'acme.garden', version: '1.0.0',
    contributes: { botTemplates: [{ id: 'garden', path: 'templates/garden.json' }, { id: 'future', path: 'templates/future.json' }] } }));
  const bytes = await createTestNpmTarball([
    { name: 'package/package.json', body: JSON.stringify({ name: '@acme/garden', version: '1.0.0', keywords: ['happier-plugin'],
      files: ['.happier-plugin', 'daemon.mjs', 'templates'], happier: { manifest: '.happier-plugin/plugin.json' },
      scripts: { install: 'must-never-execute' }, dependencies: { 'must-never-install': '*' } }) },
    { name: 'package/.happier-plugin/plugin.json', body: JSON.stringify(manifest) },
    { name: 'package/daemon.mjs', body: 'throw new Error("must-never-activate")' },
    { name: 'package/templates/garden.json', body: JSON.stringify(release) },
    { name: 'package/templates/future.json', body: '{"v":999}' },
  ]);
  const compatibility = createPluginCompatibilityProjectionV1({ manifest, uiArtifacts: { version: 2, entries: [] } });
  const discovery = createMarketplaceNpmDiscoveryProjectionV1({ compatibility,
    manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}` });
  // The catalog boundary supplies real generated metadata; archive staging independently admits its bytes.
  const listing = { pluginId: manifest.id, publisher: { id: 'acme', displayName: 'Acme' }, display: discovery.display,
    distribution: { kind: 'npm', registryOrigin: 'https://registry.example.test', packageName: '@acme/garden', version: '1.0.0', integrity: sriSha512(bytes) },
    manifestDigest: discovery.manifestDigest, compatibility: { platforms: [] }, summary: discovery.summary,
    review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy: 'allowed', links: {} };
  const source: RegistrySourceDescriptorV1 = { id: format === 'happier-catalog'
    ? deriveMarketplaceSourceId('https://catalog.example.test/index.json') : 'templates', title: 'Templates', format, kinds: ['plugin'],
    url: format === 'happier-npm' ? 'https://registry.example.test' : 'https://catalog.example.test/index.json',
    enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
  const downloads: string[] = [];
  const http: RegistryHttpV1 = { getJson: async url => ({ ok: true, fetchedAt: 1, value: new URL(url).origin === 'https://registry.example.test'
    ? { name: '@acme/garden', versions: { '1.0.0': { name: '@acme/garden', version: '1.0.0', _npmUser: { name: 'acme' },
      dist: { integrity: sriSha512(bytes), tarball: 'https://registry.example.test/garden.tgz' },
      happier: { compatibilityProjection: compatibility, marketplaceDiscovery: discovery } } } }
    : { source: { id: source.id, sourceUrl: source.url, title: source.title, kind: 'user' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [listing], diagnostics: [] } }),
    getText: async () => { throw new Error('No text transport expected'); },
    getBytes: async url => { downloads.push(url); return { ok: true, value: bytes, fetchedAt: 1 }; } };
  const itemId = format === 'happier-npm' ? '@acme/garden' : manifest.id;
  const pointer = { sourceId: source.id, itemId, version: '1.0.0' };
  const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [source],
    readPluginBotTemplates: createCliRegistryBotTemplateReaderV1({ temporaryDirectory: root }) });
  expect(await host.readBotTemplateContributions(pointer)).toEqual(manifest.contributes.botTemplates);
  expect(downloads).toEqual([]);
  expect(await host.readBotTemplate(pointer, 'garden')).toEqual({ release, source: { kind: 'plugin', registryItem: pointer, contributionId: 'garden' } });
  expect(downloads).toHaveLength(1);
  expect(await readdir(root)).toEqual([]);
  await expect(host.readBotTemplate(pointer, 'missing')).rejects.toMatchObject({ code: 'invalid_source' });
  await expect(host.readBotTemplate(pointer, 'future')).rejects.toMatchObject({ code: 'newer_format' });
  expect(await readdir(root)).toEqual([]);
  const sharedMachineHost = createRegistryHostV1({ host: 'node', http,
    readSources: async () => [{ ...source, npmRegistryProfileId: 'custodian-private' }],
    readPluginBotTemplates: createCliRegistryBotTemplateReaderV1({ temporaryDirectory: root, allowMachineNpmProfiles: false }) });
  const previousDownloads = downloads.length;
  await expect(sharedMachineHost.readBotTemplate(pointer, 'garden')).rejects.toMatchObject({ code: 'auth_failed' });
  expect(downloads).toHaveLength(previousDownloads);
  expect(await readdir(root)).toEqual([]);
});

it('reports an unavailable registry transport before acquiring a selected template', async () => {
  const { createRegistryHostV1 } = await import('@happier-dev/protocol/registries');
  const { createCliRegistryBotTemplateReaderV1 } = await import('./botTemplates');
  const host = createRegistryHostV1({ host: 'node', readSources: async () => [{ id: 'templates', title: 'Templates',
    format: 'happier-npm', kinds: ['plugin'], url: 'https://registry.example.test', enabled: true,
    addedAt: 0, origin: { kind: 'user' }, removable: true }],
    http: { getJson: async () => { throw new TypeError('Network unavailable'); },
      getText: async () => { throw new TypeError('Network unavailable'); },
      getBytes: async () => { throw new TypeError('Network unavailable'); } },
    readPluginBotTemplates: createCliRegistryBotTemplateReaderV1() });
  await expect(host.readBotTemplate({ sourceId: 'templates', itemId: '@acme/garden', version: '1.0.0' }, 'garden'))
    .rejects.toMatchObject({ code: 'unreachable' });
});

it.each(['happier-npm', 'happier-catalog'] as const)('keeps a selected preview pinned and obtains an allowed update from the existing latest metadata in %s', async format => {
  const { createCliRegistryBotTemplateReaderV1 } = await import('./botTemplates');
  const [{ createPluginCompatibilityProjectionV1 }, { PluginManifestV2Schema }, { createMarketplaceNpmDiscoveryProjectionV1 },
    { createRegistryHostV1 }, { BotTemplateReleaseV1Schema }] = await Promise.all([
    import('@happier-dev/protocol/plugins/availability/compatibilityProjectionV1'), import('@happier-dev/protocol/plugins/manifest'),
    import('@happier-dev/protocol/marketplace'), import('@happier-dev/protocol/registries'), import('@happier-dev/protocol/bots/templates/botTemplateV1'),
  ]);
  const { deriveMarketplaceSourceId } = await import('@happier-dev/protocol/marketplace');
  const releases = await Promise.all(['1.0.0', '2.0.0'].map(async version => {
    const release = BotTemplateReleaseV1Schema.parse({ v: 1, version, releasedAtMs: 1, changelog: '',
      content: { v: 1, identity: { name: version, description: '' }, instructions: { markdown: version },
        memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
    const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({ id: 'acme.updates', version,
      contributes: { botTemplates: [{ id: 'template', path: 'template.json' }] } }));
    const bytes = await createTestNpmTarball([
      { name: 'package/package.json', body: JSON.stringify({ name: '@acme/updates', version, keywords: ['happier-plugin'],
        files: ['.happier-plugin', 'template.json', 'daemon.mjs'], happier: { manifest: '.happier-plugin/plugin.json' } }) },
      { name: 'package/.happier-plugin/plugin.json', body: JSON.stringify(manifest) },
      { name: 'package/template.json', body: JSON.stringify(release) },
      { name: 'package/daemon.mjs', body: 'throw new Error("must-never-activate")' },
    ]);
    const compatibility = createPluginCompatibilityProjectionV1({ manifest, uiArtifacts: { version: 2, entries: [] } });
    const discovery = createMarketplaceNpmDiscoveryProjectionV1({ compatibility,
      manifestDigest: `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}` });
    return { version, release, bytes, listing: { pluginId: manifest.id, publisher: { id: 'acme', displayName: 'Acme' }, display: discovery.display,
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example.test', packageName: '@acme/updates', version, integrity: sriSha512(bytes) },
      manifestDigest: discovery.manifestDigest, compatibility: { platforms: [] }, summary: discovery.summary,
      review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], links: {} },
      metadata: { name: '@acme/updates', version, _npmUser: { name: 'acme' },
      dist: { integrity: sriSha512(bytes), tarball: `https://registry.example.test/${version}.tgz` },
      happier: { compatibilityProjection: compatibility, marketplaceDiscovery: discovery } } };
  }));
  let pinned = false;
  const source: RegistrySourceDescriptorV1 = { id: format === 'happier-npm' ? 'updates' : deriveMarketplaceSourceId('https://catalog.example.test/updates.json'),
    title: 'Updates', format, kinds: ['plugin'], url: format === 'happier-npm' ? 'https://registry.example.test' : 'https://catalog.example.test/updates.json',
    enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
  const host = createRegistryHostV1({ host: 'node', readSources: async () => [source],
    http: { getJson: async url => ({ ok: true, fetchedAt: 1, value: new URL(url).origin === 'https://registry.example.test'
      ? { name: '@acme/updates', 'dist-tags': { latest: '2.0.0' }, versions: Object.fromEntries(releases.map(value => [value.version, value.metadata])) }
      : { source: { id: source.id, sourceUrl: source.url, title: source.title, kind: 'user' }, freshness: { state: 'fresh', fetchedAtMs: 1 },
        entries: releases.map(value => ({ ...value.listing, updatePolicy: pinned ? 'pinned' : 'allowed' })), diagnostics: [] } }),
      getText: async () => { throw new Error('No text read expected'); },
      getBytes: async url => ({ ok: true, fetchedAt: 1, value: releases.find(value => url.endsWith(`/${value.version}.tgz`))!.bytes }) },
    readPluginBotTemplates: createCliRegistryBotTemplateReaderV1() });
  const pointer = { sourceId: source.id, itemId: format === 'happier-npm' ? '@acme/updates' : 'acme.updates', version: '1.0.0' };
  expect((await host.readBotTemplate(pointer, 'template')).release.version).toBe('1.0.0');
  const offered = await host.readBotTemplateUpdate(pointer, 'template');
  expect(offered.release.version).toBe('2.0.0');
  expect(offered.source).toEqual({ kind: 'plugin', registryItem: { ...pointer, version: '2.0.0' }, contributionId: 'template' });
  if (format === 'happier-catalog') {
    pinned = true;
    expect((await host.readBotTemplateUpdate(pointer, 'template')).release.version).toBe('1.0.0');
  }
});
