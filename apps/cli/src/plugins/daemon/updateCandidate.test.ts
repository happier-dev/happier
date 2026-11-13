import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type { PluginStateRecord } from '@/plugins/store/state';
import { readInstalledPluginUpdateCandidate } from './updateCandidate';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function home() { const root = await mkdtemp(join(tmpdir(), 'plugin-update-read-')); roots.push(root); return root; }
type TrustDistribution = NonNullable<NonNullable<PluginStateRecord['install']>['trust']>['distribution'];
function record(pluginId = 'acme.example',
  distribution: TrustDistribution = { kind: 'npm', packageName: '@acme/example', registryOrigin: 'https://registry.npmjs.org' }): PluginStateRecord {
  return { source: { kind: 'package', locator: '@acme/example', trustPolicy: 'prompt', installPolicy: 'managed_install',
    resolvedPath: '/installed', manifestPath: '/installed/plugin.json' }, compatibility: { status: 'compatible', diagnostics: [] },
    install: { mode: 'managed_install', manifestVersion: '1.0.0', updatePolicy: 'allowed', trust: { pluginId, state: 'trusted', approvedAtMs: 1,
      distribution } }, state: { enabled: true } };
}
it('reads the existing npm selector without downloading, installing or changing the baseline', async () => {
  const happyHomeDir = await home();
  const installed = record();
  const before = JSON.stringify(installed);
  const requests: string[] = [];
  const result = await readInstalledPluginUpdateCandidate({ pluginId: 'acme.example', installed, happyHomeDir,
    createNpmClient: () => ({ getJson: async ({ url }) => {
      requests.push(url);
      return { name: '@acme/example', versions: { '1.1.0': { name: '@acme/example', version: '1.1.0',
        happier: { compatibilityProjection: { version: 1, manifest: { schemaVersion: 2, id: 'acme.example', version: '1.1.0', displayName: 'Example', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 }, contributes: {} }, uiArtifacts: { version: 2, entries: [] } } },
        dist: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, tarball: 'https://registry.npmjs.org/example.tgz' } } } };
    } }) });
  expect(result).toEqual({ pluginId: 'acme.example', installedVersion: '1.0.0', state: 'resolved', candidateVersion: '1.1.0' });
  expect(requests).toEqual(['https://registry.npmjs.org/%40acme%2Fexample']);
  expect(JSON.stringify(installed)).toBe(before);
  await expect(readFile(resolvePluginStorePaths({ happyHomeDir }).registryCurrentFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
it('returns the lifecycle refusal for pinned and untrusted installs without registry traffic', async () => {
  const happyHomeDir = await home();
  for (const [installed, code] of [
    [{ ...record(), install: { ...record().install, updatePolicy: 'pinned' as const } }, 'plugin_update_pinned'],
    [{ ...record(), install: { ...record().install, trust: undefined } }, 'plugin_update_trust_unavailable'],
  ] as const) {
    expect(await readInstalledPluginUpdateCandidate({ pluginId: 'acme.example', installed, happyHomeDir,
      createNpmClient: () => { throw new Error('unexpected registry traffic'); } })).toMatchObject({ state: 'unavailable', reason: { code } });
  }
});
it('reads a trusted local source and refuses a substituted plugin identity', async () => {
  const happyHomeDir = await home();
  const source = join(happyHomeDir, 'source');
  await mkdir(join(source, '.happier-plugin'), { recursive: true });
  const manifestPath = join(source, '.happier-plugin/plugin.json');
  const manifest = { schemaVersion: 2, id: 'acme.example', version: '1.2.0', displayName: 'Example', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 }, contributes: {} };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const installed = record('acme.example', { kind: 'localPath', canonicalPath: source });
  expect(await readInstalledPluginUpdateCandidate({ pluginId: 'acme.example', installed, happyHomeDir })).toMatchObject({ state: 'resolved', candidateVersion: '1.2.0' });
  await writeFile(manifestPath, JSON.stringify({ ...manifest, id: 'acme.substitute' }));
  expect(await readInstalledPluginUpdateCandidate({ pluginId: 'acme.example', installed, happyHomeDir })).toMatchObject({ state: 'unavailable', reason: { code: 'plugin_update_identity_mismatch' } });
});
it('reads an archive manifest without invoking its package scripts or preparing installed storage', async () => {
  const happyHomeDir = await home();
  const { createTestNpmTarball } = await import('@/plugins/distribution/testkit/npmTarball');
  const archivePath = join(happyHomeDir, 'source.tgz');
  await writeFile(archivePath, await createTestNpmTarball([
    { name: 'package/package.json', body: JSON.stringify({ name: '@acme/example', version: '1.3.0', keywords: ['happier-plugin'], files: ['.happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' }, scripts: { preinstall: 'exit 1' } }) },
    { name: 'package/.happier-plugin/plugin.json', body: JSON.stringify({ schemaVersion: 2, id: 'acme.example', version: '1.3.0', displayName: 'Example', engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 }, contributes: {} }) },
  ]));
  const installed = record('acme.example', { kind: 'archive', source: { kind: 'localFile', canonicalPath: archivePath } });
  expect(await readInstalledPluginUpdateCandidate({ pluginId: 'acme.example', installed, happyHomeDir })).toEqual({ pluginId: 'acme.example', installedVersion: '1.0.0', state: 'resolved', candidateVersion: '1.3.0' });
  expect(await readdir(happyHomeDir)).toEqual(['source.tgz']);
});
