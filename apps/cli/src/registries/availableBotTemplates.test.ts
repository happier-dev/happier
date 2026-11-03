import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';
import { BotTemplateReleaseV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import type { RegistryItemV1, RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';

import { createNpmPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readPluginRegistryCommitRecord, replacePluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import { persistInstallationStateRevision, readInstallationStateRevision } from '@/plugins/store/registry/generationStore';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const source = { id: 'templates', title: 'Templates', format: 'happier-npm', kinds: ['plugin'],
  url: 'https://registry.example.test', enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true } satisfies RegistrySourceDescriptorV1;
const pointer = { sourceId: source.id, itemId: '@acme/garden', version: '1.0.0' };
const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;

async function installedTemplate() {
  const home = await mkdtemp(join(tmpdir(), 'happier-available-template-')); roots.push(home);
  const pluginRoot = join(home, 'source');
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await mkdir(join(pluginRoot, 'templates'));
  const release = BotTemplateReleaseV1Schema.parse({ v: 1, version: '2.0.0', releasedAtMs: 1, changelog: 'Garden update',
    content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Use native plants.' },
      memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
  const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({ id: 'acme.garden', version: '1.0.0',
    contributes: { botTemplates: [{ id: 'garden', path: './templates/garden.json' }, { id: 'future', path: 'templates/future.json' }] } }));
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestDigest = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
  await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), manifestBytes);
  await writeFile(join(pluginRoot, 'daemon.mjs'), 'throw new Error("must-never-activate")');
  await writeFile(join(pluginRoot, 'templates/garden.json'), JSON.stringify(release));
  await writeFile(join(pluginRoot, 'templates/future.json'), '{"v":999}');
  const distribution = createNpmPluginDistributionIdentity({ registryOrigin: source.url, packageName: pointer.itemId });
  const generation = await writeCommittedLocalPathPluginFixture({ happyHomeDir: home, pluginId: manifest.id, sourceRootPath: pluginRoot,
    plugin: {
      source: { kind: 'package', locator: pointer.itemId, resolvedVersion: pointer.version, trustPolicy: 'prompt',
        installPolicy: 'managed_install', resolvedPath: pluginRoot, manifestPath: join(pluginRoot, '.happier-plugin/plugin.json') },
      compatibility: { status: 'compatible', diagnostics: [] },
      install: { mode: 'managed_install', manifestVersion: manifest.version,
        trust: createPluginTrustRecord({ pluginId: manifest.id, distribution, approvedAtMs: 0 }) },
      state: { enabled: false },
    } });
  const paths = resolvePluginStorePaths({ happyHomeDir: home });
  const commit = await readPluginRegistryCommitRecord(paths);
  if (!commit) throw new Error('Fixture has no committed installation');
  const revision = await readInstallationStateRevision({ paths, reference: commit.installationState });
  const installationState = await persistInstallationStateRevision({ paths, state: { ...revision, revisionId: `state-${randomUUID()}`,
    plugins: { ...revision.plugins, [manifest.id]: { ...revision.plugins[manifest.id]!, source: { distribution, admittedIntegrity: integrity } } } } });
  await replacePluginRegistryCommitRecord({ paths, expectedCurrent: commit, next: { ...commit, revision: commit.revision + 1,
    baseRevision: commit.revision, transactionId: `fixture-${randomUUID()}`, installationState } });
  return { home, pluginRoot, generation, release, manifest, manifestDigest };
}

it('reads the selected disabled installed npm template offline from its committed generation without activation', async () => {
  const { createCliAvailableBotTemplateReaderV1 } = await import('./availableBotTemplates');
  const fixture = await installedTemplate();
  await writeFile(join(fixture.pluginRoot, 'templates/garden.json'), '{"v":999}');
  const read = createCliAvailableBotTemplateReaderV1({ happyHomeDir: fixture.home });
  expect(await read({ source, pointer, contributionId: 'garden' })).toEqual({ release: fixture.release,
    source: { kind: 'plugin', registryItem: pointer, contributionId: 'garden' } });
  await expect(read({ source, pointer, contributionId: 'future' })).rejects.toMatchObject({ code: 'newer_format' });
  await expect(read({ source, pointer, contributionId: 'missing' })).rejects.toMatchObject({ code: 'invalid_source' });
});

it('declines different npm coordinates, unpinned pointers and unbound indexed sources', async () => {
  const { createCliAvailableBotTemplateReaderV1 } = await import('./availableBotTemplates');
  const fixture = await installedTemplate();
  const read = createCliAvailableBotTemplateReaderV1({ happyHomeDir: fixture.home });
  for (const input of [
    { source, pointer: { ...pointer, version: 'latest' } },
    { source, pointer: { ...pointer, version: '1.0.1' } },
    { source, pointer: { ...pointer, itemId: '@other/garden' } },
    { source: { ...source, url: 'https://other.example.test' }, pointer },
    { source: { ...source, format: 'happier-catalog' as const, url: 'https://catalog.example.test/index.json' },
      pointer: { ...pointer, itemId: fixture.manifest.id } },
  ]) expect(await read({ ...input, contributionId: 'garden' })).toBeNull();
});

it('reuses installed indexed bytes only after the listing binds their exact package identity, integrity and manifest digest', async () => {
  const { createCliAvailableBotTemplateReaderV1 } = await import('./availableBotTemplates');
  const fixture = await installedTemplate();
  const read = createCliAvailableBotTemplateReaderV1({ happyHomeDir: fixture.home });
  const indexedSource: RegistrySourceDescriptorV1 = { ...source, format: 'happier-catalog', url: 'https://catalog.example.test/index.json' };
  const indexedPointer = { ...pointer, itemId: fixture.manifest.id };
  const item: RegistryItemV1 = { summary: { sourceId: source.id, kind: 'plugin', itemId: fixture.manifest.id, title: 'Garden', version: pointer.version },
    payload: { kind: 'plugin', source: { id: source.id, title: source.title, sourceUrl: indexedSource.url, kind: 'user' },
      listing: { pluginId: fixture.manifest.id, publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Garden', description: null },
        distribution: { kind: 'npm', registryOrigin: source.url, packageName: pointer.itemId, version: pointer.version, integrity },
        manifestDigest: fixture.manifestDigest, compatibility: { platforms: [] },
        summary: { contributions: ['botTemplates'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: [] },
        review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy: 'allowed', links: {} } }, fetchedAt: 1 };
  expect(await read({ source: indexedSource, pointer: indexedPointer, item, contributionId: 'garden' })).toMatchObject({ release: fixture.release });
  if (item.payload.kind !== 'plugin') throw new Error('Expected plugin fixture');
  for (const distribution of [
    { ...item.payload.listing.distribution, integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}` },
    { ...item.payload.listing.distribution, registryOrigin: 'https://other.example.test' },
    { ...item.payload.listing.distribution, packageName: '@other/garden' },
    { ...item.payload.listing.distribution, version: '1.0.1' },
  ]) expect(await read({ source: indexedSource, pointer: indexedPointer, contributionId: 'garden',
    item: { ...item, payload: { ...item.payload, listing: { ...item.payload.listing, distribution } } } })).toBeNull();
  await expect(read({ source: indexedSource, pointer: indexedPointer, contributionId: 'garden',
    item: { ...item, payload: { ...item.payload, listing: { ...item.payload.listing,
      manifestDigest: `sha256:${'a'.repeat(64)}` } } } })).rejects.toMatchObject({ code: 'invalid_source' });
});
