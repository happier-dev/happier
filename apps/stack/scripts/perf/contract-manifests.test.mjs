import assert from 'node:assert/strict';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { probeRuntimeImport } from '../utils/proc/runtimeImportProbe.mjs';
import { createLoadSentinel, sentinelGraphs } from './load-sentinel.mjs';
import { BUNDLED_MANIFEST_GRAPH, loadBundledManifestContracts } from './contract-manifests.mjs';

const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));

test('manifest probe rejects stale provisioner byte schemas without rewriting declarations', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-manifest-contract-' });
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const pluginDir = join(repoDir, 'packages/plugins/machine-fly');
  await Promise.all([mkdir(join(cliDir, 'scripts/build-owned'), { recursive: true }),
    mkdir(join(pluginDir, 'src'), { recursive: true })]);
  await Promise.all([
    // The real CLI main compares argv[1] with import.meta.url, so a symlink
    // entry would silently skip it. Invoke its exported main in this fixture.
    writeFile(join(repoDir, BUNDLED_MANIFEST_GRAPH.entry),
      `import { main } from ${JSON.stringify(pathToFileURL(join(sourceRepo, BUNDLED_MANIFEST_GRAPH.entry)).href)};\nawait main();\n`),
    symlink(join(sourceRepo, 'packages/cli-common'), join(repoDir, 'packages/cli-common'), 'junction'),
    writeFile(join(repoDir, 'package.json'), JSON.stringify({ type: 'module' })),
    writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module',
      bundledDependencies: ['@happier-dev/plugins-machine-fly'],
      dependencies: { '@happier-dev/plugins-machine-fly': '0.0.0' } })),
  ]);
  // Use the real compacted provisioner declaration, including its role agreement.
  const manifest = JSON.parse(await readFile(join(sourceRepo,
    'apps/cli/assets/bundled-plugin-manifests/machine-fly.json'), 'utf8'));
  await Promise.all([
    writeFile(join(pluginDir, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-machine-fly',
      version: manifest.version, type: 'module' })),
    writeFile(join(pluginDir, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};\n`),
  ]);
  // The generator derives this fixture's baseline into private output, never the checkout.
  const output = fixture.path('derived');
  const prepared = await probeRuntimeImport({ entrypoint: join(sourceRepo, BUNDLED_MANIFEST_GRAPH.entry),
    nodeArgs: ['--conditions=happier-source', '--import', join(sourceRepo, 'packages/cli-common/registerSourceRuntime.mjs')],
    args: ['--root', repoDir, '--mode', 'write', '--daemon-projections', '--daemon-output-root', output],
    cwd: sourceRepo });
  assert.equal(prepared.status, 'passed', 'real manifest fixture must derive successfully');
  await cp(join(output, 'apps/cli/assets'), join(cliDir, 'assets'), { recursive: true });
  await cp(join(output, 'apps/cli/src'), join(cliDir, 'src'), { recursive: true });

  // This private wrapper lives outside the source checkout; use the real
  // generator's config rather than relying on entry-path inference.
  const env = { ...process.env, TSX_TSCONFIG_PATH: join(sourceRepo, 'apps/cli/tsconfig.runtime.json') };
  const baseline = await loadBundledManifestContracts({ repoDir, env });
  assert.equal(baseline.status, 'passed');
  const assetPath = join(cliDir, 'assets/bundled-plugin-manifests/machine-fly.json');
  const stale = JSON.parse(await readFile(assetPath, 'utf8'));
  const bytesSchema = stale.contributes.actions.find(action => action.inputSchema?.properties?.bytesBase64)
    ?.inputSchema.properties.bytesBase64;
  assert.equal(bytesSchema?.format, 'byte', 'fixture must exercise the provisioner byte-format contract');
  delete bytesSchema.format;
  const staleBytes = JSON.stringify(stale);
  await writeFile(assetPath, staleBytes);
  const results = [], posts = [];
  await createLoadSentinel({ repoDir, env, graphs: sentinelGraphs().filter(graph => graph.id === BUNDLED_MANIFEST_GRAPH.id),
    signal: t.signal, waitForQuiet: async () => {}, onResult: result => results.push(result),
    post: async notice => posts.push(notice) }).request();
  const failed = results.at(-1);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /URGENT/);
  assert.equal(failed.graph, BUNDLED_MANIFEST_GRAPH.id);
  assert.equal(failed.status, 'failed', 'stale byte format must fail the sentinel graph');
  assert.equal(failed.exitCode, 1);
  assert.ok(failed.elapsedMs > 0);
  assert.equal(await readFile(assetPath, 'utf8'), staleBytes, 'check must preserve stale bytes for their publisher');
});
