import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolvePluginSdkVersion, releasePlugin, withTemporaryPublicationFiles, derivePluginPublicationToolchain } from './release-plugin.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test('the SDK published in this run takes precedence without a registry read', async () => {
  assert.equal(await resolvePluginSdkVersion({ channel: 'preview', sdkVersion: '0.1.0-preview.7', readPublishedVersion() {
    throw new Error('unexpected registry read');
  } }), '0.1.0-preview.7');
});

test('a plugin-only release resolves the exact SDK from its channel dist-tag', async () => {
  for (const [channel, tag] of [['production', 'latest'], ['preview', 'next'], ['dev', 'dev']]) {
    const version = await resolvePluginSdkVersion({ channel, readPublishedVersion(spec) {
      assert.equal(spec, `@happier-dev/plugin-sdk@${tag}`);
      return '0.1.0-preview.8';
    } });
    assert.equal(version, '0.1.0-preview.8');
  }
});

test('missing, ranged or malformed SDK resolution fails before packing', async () => {
  for (const version of ['', null, '^0.1.0', 'workspace:*', '0.1.0\nunsafe=value']) {
    await assert.rejects(resolvePluginSdkVersion({ channel: 'preview', readPublishedVersion: () => version }), /exact.*Plugin SDK.*next/i);
  }
  await assert.rejects(resolvePluginSdkVersion({ channel: 'preview', readPublishedVersion() { throw new Error('registry unavailable'); } }), /registry unavailable/);
});

test('temporary publication metadata and generated projection restore on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-release-plugin-files-'));
  const manifest = join(root, 'package.json');
  const packet = join(root, 'packet.ts');
  await writeFile(manifest, '{"version":"0.0.0"}\n');
  await writeFile(packet, 'source packet\n');
  try {
    await assert.rejects(withTemporaryPublicationFiles([
      { path: manifest, contents: '{"version":"0.1.0-preview.1"}\n' },
      { path: packet, contents: 'release packet\n' },
    ], async () => {
      assert.equal(await readFile(packet, 'utf8'), 'release packet\n');
      assert.match(await readFile(manifest, 'utf8'), /preview/);
      throw new Error('pack rejected');
    }), /pack rejected/);
    assert.equal(await readFile(packet, 'utf8'), 'source packet\n');
    assert.equal(await readFile(manifest, 'utf8'), '{"version":"0.0.0"}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication uses the canonical generator with the selected SDK pair and real host identity', async () => {
  const source = await readFile(join(repoRoot, 'packages/plugin-sdk/src/ui/build/publicToolchainCompatibility.generated.ts'), 'utf8');
  const packet = await derivePluginPublicationToolchain(repoRoot, '0.1.0-preview.9');
  assert.match(packet, /"pluginSdk": \{\s*"version": "0.1.0-preview.9"/);
  assert.match(packet, /"pluginSdkVersion": "0.1.0-preview.9"/);
  const cli = JSON.parse(await readFile(join(repoRoot, 'apps/cli/package.json'), 'utf8'));
  assert.ok(packet.includes(`@happier-dev/cli@${cli.version}`));
  assert.equal(await readFile(join(repoRoot, 'packages/plugin-sdk/src/ui/build/publicToolchainCompatibility.generated.ts'), 'utf8'), source);
});

test('a fresh trusted control checkout uses the built source generator rather than control Protocol dist', async () => {
  const control = await mkdtemp(join(tmpdir(), 'happier-release-plugin-control-'));
  try {
    await mkdir(join(control, 'scripts/pipeline/npm'), { recursive: true });
    await mkdir(join(control, 'packages/plugin-sdk/scripts'), { recursive: true });
    await copyFile(join(repoRoot, 'scripts/pipeline/npm/release-plugin.mjs'), join(control, 'scripts/pipeline/npm/release-plugin.mjs'));
    await copyFile(join(repoRoot, 'packages/plugin-sdk/scripts/generatePublicToolchainCompatibility.mjs'), join(control, 'packages/plugin-sdk/scripts/generatePublicToolchainCompatibility.mjs'));
    await symlink(join(repoRoot, 'node_modules'), join(control, 'node_modules'), 'junction');
    await symlink(join(repoRoot, 'scripts/plugins'), join(control, 'scripts/plugins'), 'junction');
    await symlink(join(repoRoot, 'scripts/pipeline/release'), join(control, 'scripts/pipeline/release'), 'junction');
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      const { derivePluginPublicationToolchain } = await import(process.argv[2]);
      process.stdout.write(await derivePluginPublicationToolchain(process.argv[3], '0.1.0-preview.11'));
    `, 'control-import-probe', join(control, 'scripts/pipeline/npm/release-plugin.mjs'), repoRoot], { encoding: 'utf8' });
    assert.match(output, /"version": "0.1.0-preview.11"/);
  } finally { await rm(control, { recursive: true, force: true }); }
});

test('an intervening edit is preserved while the other temporary files still restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-release-plugin-concurrent-'));
  const manifest = join(root, 'package.json');
  const packet = join(root, 'packet.ts');
  await writeFile(manifest, 'source manifest');
  await writeFile(packet, 'source packet');
  try {
    await assert.rejects(withTemporaryPublicationFiles([
      { path: manifest, contents: 'release manifest' }, { path: packet, contents: 'release packet' },
    ], () => writeFile(packet, 'intervening edit')), /refusing to overwrite/);
    assert.equal(await readFile(packet, 'utf8'), 'intervening edit');
    assert.equal(await readFile(manifest, 'utf8'), 'source manifest');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed admission records plugin identity and cannot reach publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-release-plugin-admission-'));
  const plugin = join(root, 'packages/plugins/example');
  const statusFile = join(root, 'status.json');
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-example', version: '0.1.0', happier: { bundled: false } }));
  try {
    await assert.rejects(releasePlugin({ repoRoot: root, pluginId: 'example', channel: 'preview', statusFile, approved: false }), /maintainer approval/);
    assert.deepEqual(JSON.parse(await readFile(statusFile, 'utf8')), { id: 'example', packageName: '@happier-dev/plugins-example', result: 'failure', version: '', integrity: '' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production cannot publish the source placeholder without an explicit admitted plugin version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-release-plugin-stable-'));
  const plugin = join(root, 'packages/plugins/example');
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-example', version: '0.0.0', happier: { bundled: false } }));
  try {
    await assert.rejects(releasePlugin({ repoRoot: root, pluginId: 'example', channel: 'production', approved: true,
      sdkVersion: '0.1.0', mode: 'pack' }), /production.*explicit.*version/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the production runner packs a real plugin archive and admits it through temporary-host installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-release-plugin-real-'));
  try {
    const source = `
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { createPluginManifestV2Fixture } from './apps/cli/src/plugins/testkit/manifestV2Fixture.ts';
      import { createPluginRegistryStateStore } from './apps/cli/src/plugins/store/registry/currentState.ts';
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { packPluginForPublication } from './scripts/pipeline/npm/pack-plugin-for-publication.mjs';
      const root = process.argv[1];
      const plugin = join(root, 'plugin');
      await mkdir(join(plugin, '.happier-plugin'), { recursive: true });
      const manifest = createPluginManifestV2Fixture({ id: 'acme.release-fixture', version: '0.1.0', entrypoints: { daemon: './daemon.mjs' } });
      await writeFile(join(plugin, 'daemon.mjs'), 'export function activate() {}');
      await writeFile(join(plugin, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
      await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'happier-release-fixture', version: '0.1.0', type: 'module', keywords: ['happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' }, files: ['daemon.mjs', '.happier-plugin'] }));
      const home = join(root, 'home');
      await mkdir(home, { recursive: true });
      const packed = await packPluginForPublication({ repoRoot: process.cwd(), happyHomeDir: home, pluginRoot: join(plugin, '.happier-plugin/plugin.json'), version: '0.1.0-preview.1', tarball: join(root, 'candidate.tgz') });
      if (packed.version !== '0.1.0-preview.1') throw new Error('published manifest version was not applied');
      const state = await createPluginRegistryStateStore({ happyHomeDir: home }).read();
      const record = state.plugins['acme.release-fixture'];
      assert.ok(record?.install.installedPath, 'the archive must be installed into the host');
      assert.equal(JSON.parse(await readFile(join(record.install.installedPath, '.happier-plugin/plugin.json'), 'utf8')).version, '0.1.0-preview.1');
      await writeFile(join(plugin, '.happier-plugin/plugin.json'), JSON.stringify({ ...manifest, engines: { happier: '>=999.0.0' } }));
      await assert.rejects(packPluginForPublication({ repoRoot: process.cwd(), pluginRoot: join(plugin, '.happier-plugin/plugin.json'), version: '0.1.0-preview.1', tarball: join(root, 'incompatible.tgz') }), /compatible Happier CLI version/);
      process.stdout.write('real-pack-install-passed');
    `;
    const output = execFileSync(process.execPath, ['--conditions=happier-source', '--import', join(repoRoot, 'packages/cli-common/registerSourceRuntime.mjs'), '--input-type=module', '--eval', source, root], {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, HAPPIER_HOME_DIR: join(root, 'home'), TSX_TSCONFIG_PATH: join(repoRoot, 'apps/cli/tsconfig.runtime.json') },
    });
    assert.match(output, /real-pack-install-passed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
