import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
  generateBundledPluginUiArtifacts,
  resolveBundledPluginUiArtifactsOutputPath,
} from './generateBundledPluginUiArtifacts.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function createFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-ui-preseed-'));
  const uiDir = join(repoRoot, 'apps', 'ui');
  const packageRoot = join(repoRoot, 'packages', 'plugins', 'fixture');
  const artifactRoot = join(packageRoot, 'dist', 'happier-plugin-ui');
  const relativePath = 'react-native/fixture-card/entry.cjs.bundle';
  const bytes = new TextEncoder().encode('module.exports = { fixture: true };\n');
  const fileDigest = computePluginUiArtifactSha256DigestV1(bytes);
  const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]);

  await mkdir(join(artifactRoot, 'react-native', 'fixture-card'), { recursive: true });
  await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
  await mkdir(uiDir, { recursive: true });
  await writeFile(join(uiDir, 'package.json'), `${JSON.stringify({
    dependencies: { '@happier-dev/plugins-fixture': '0.0.0' },
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@happier-dev/plugins-fixture',
    version: '0.0.0',
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), `${JSON.stringify({
    id: 'happier.fixture',
  }, null, 2)}\n`);
  await writeFile(join(artifactRoot, relativePath), bytes);
  await writeFile(join(artifactRoot, 'ui-artifacts.json'), `${JSON.stringify({
    version: 2,
    entries: [{
      artifactId: 'fixture-card',
      tier: 'reactNative',
      entry: relativePath,
      files: [{ relativePath, digest: fileDigest, byteSize: bytes.byteLength }],
      digest: artifactDigest,
      builtWith: { bundler: 'esbuild', version: '1.0.0' },
      executable: { exports: ['renderSurface'] },
      hostUiApiRange: '^1.0.0',
    }],
  }, null, 2)}\n`);

  return { repoRoot, artifactRoot, relativePath };
}

async function addSecondPlugin(repoRoot) {
  const packageRoot = join(repoRoot, 'packages', 'plugins', 'second');
  const artifactRoot = join(packageRoot, 'dist', 'happier-plugin-ui');
  const relativePath = 'react-native/second-card/entry.cjs.bundle';
  const bytes = new TextEncoder().encode('module.exports = { second: true };\n');
  await mkdir(join(artifactRoot, 'react-native', 'second-card'), { recursive: true });
  await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
  const uiPackagePath = join(repoRoot, 'apps', 'ui', 'package.json');
  const uiPackage = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  uiPackage.dependencies['@happier-dev/plugins-second'] = '0.0.0';
  await writeFile(uiPackagePath, `${JSON.stringify(uiPackage)}\n`);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-second', version: '0.0.0',
  }));
  await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    id: 'happier.second',
  }));
  await writeFile(join(artifactRoot, relativePath), bytes);
  await writeFile(join(artifactRoot, 'ui-artifacts.json'), JSON.stringify({
    version: 2,
    entries: [{
      artifactId: 'second-card', tier: 'reactNative', entry: relativePath,
      files: [{
        relativePath,
        digest: computePluginUiArtifactSha256DigestV1(bytes),
        byteSize: bytes.byteLength,
      }],
      digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]),
      builtWith: { bundler: 'esbuild', version: '1.0.0' },
      executable: { exports: ['renderSurface'] },
      hostUiApiRange: '^1.0.0',
    }],
  }));
}

test('the UI prebuild owns one universal exact app-preseed registry from canonical artifact manifests', async () => {
  const fixture = await createFixture();
  try {
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });

    const outputPath = resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot);
    assert.match(outputPath, /generatedBundledPluginUiArtifacts\.js$/);
    const output = await readFile(outputPath, 'utf8');
    assert.doesNotMatch(output, /import type|\]\) satisfies/);
    assert.match(output, /@satisfies \{import\('\.\/bundledPluginUiArtifactInventory'\)\.BundledPluginUiAppArtifactInventory\}/);
    assert.match(output, /apps\/ui\/scripts\/generateBundledPluginUiArtifacts\.mjs/);
    assert.match(
      output,
      /require\("@happier-dev\/plugins-fixture\/happier-plugin-ui\/react-native\/fixture-card\/entry\.cjs\.bundle"\)/,
    );
    assert.match(output, /pluginId: "happier\.fixture"/);
    assert.match(output, /artifactId: "fixture-card"/);
    assert.doesNotMatch(output, /platform:/);

    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'check' });
    await writeFile(outputPath, '// stale\n');
    await assert.rejects(
      () => generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'check' }),
      /out of date/i,
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('source preparation projects private artifacts without touching package dist or the live inventory', async () => {
  const fixture = await createFixture();
  try {
    const privateRoot = join(fixture.repoRoot, 'private-inputs');
    const privateArtifacts = join(privateRoot, 'fixture', 'happier-plugin-ui');
    const { cp } = await import('node:fs/promises');
    await cp(fixture.artifactRoot, privateArtifacts, { recursive: true });
    await rm(fixture.artifactRoot, { recursive: true });
    const outputPath = join(privateRoot, 'inventory.js');
    await generateBundledPluginUiArtifacts({
      repoRoot: fixture.repoRoot, publicationMode: 'artifact', outputPath,
      artifactRoots: { fixture: privateArtifacts },
      pluginManifests: { fixture: { id: 'happier.authored-fixture' } },
    });
    const output = await readFile(outputPath, 'utf8');
    assert.match(output, /happier\.authored-fixture/);
    assert.ok(output.includes(JSON.stringify(join(privateArtifacts, fixture.relativePath))));
    await assert.rejects(stat(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot)), { code: 'ENOENT' });
    await assert.rejects(stat(fixture.artifactRoot), { code: 'ENOENT' });
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('the emitted JavaScript and committed declaration satisfy the inventory contract', async () => {
  const fixture = await createFixture();
  try {
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const outputPath = resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot);
    const fixtureDir = dirname(outputPath);
    const contractDir = join(packageRoot, 'sources', 'sync', 'domains', 'plugins', 'availability');
    for (const filename of [
      'bundledPluginUiArtifactInventory.ts',
      'generatedBundledPluginUiArtifacts.d.ts',
    ]) {
      await writeFile(join(fixtureDir, filename), await readFile(join(contractDir, filename)));
    }
    const ambientPath = join(fixtureDir, 'asset-boundaries.d.ts');
    await writeFile(ambientPath, [
      "declare module 'expo-asset' { export class Asset { static fromModule(id: number): number; } }",
      "declare module '@happier-dev/protocol/plugins/ui' { export type PluginUiArtifactDigestV1 = `sha256:${string}`; }",
      "declare module '*.bundle' { const asset: number; export = asset; }",
      '',
    ].join('\n'));
    const consumerPath = join(fixtureDir, 'consumer.ts');
    await writeFile(consumerPath, [
      "import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } from './generatedBundledPluginUiArtifacts';",
      "import type { BundledPluginUiAppArtifactInventory } from './bundledPluginUiArtifactInventory';",
      'const inventory: BundledPluginUiAppArtifactInventory = BUNDLED_PLUGIN_UI_APP_ARTIFACTS;',
      'void inventory;',
      '',
    ].join('\n'));
    const compiler = resolve(packageRoot, '..', '..', 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
    const compilerArguments = [
      compiler, '--allowJs', '--checkJs', '--noEmit', '--strict', '--skipLibCheck',
      '--moduleResolution', 'bundler', '--module', 'esnext', '--target', 'es2022',
      outputPath, consumerPath, ambientPath,
    ];
    await execFileAsync(process.execPath, compilerArguments);
    const validOutput = await readFile(outputPath, 'utf8');
    await writeFile(outputPath, validOutput.replace('    releaseVersion: "0.0.0",\n', ''));
    await assert.rejects(
      execFileAsync(process.execPath, compilerArguments),
      (error) => {
        assert.match(error.stdout, /releaseVersion/);
        return true;
      },
    );
    await rm(outputPath);
    await execFileAsync(process.execPath, [
      compiler, '--noEmit', '--strict', '--skipLibCheck',
      '--moduleResolution', 'bundler', '--module', 'esnext', '--target', 'es2022',
      consumerPath, ambientPath,
    ]);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('unchanged Plugin UI artifact inputs preserve the generated compiler input', async () => {
  const fixture = await createFixture();
  try {
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const outputPath = resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot);
    const first = await stat(outputPath);

    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const unchanged = await stat(outputPath);
    assert.equal(unchanged.ino, first.ino);
    assert.equal(unchanged.mtimeMs, first.mtimeMs);

    const packageJsonPath = join(fixture.repoRoot, 'packages', 'plugins', 'fixture', 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    await writeFile(packageJsonPath, JSON.stringify({ ...packageJson, version: '0.0.1' }));
    const uiPackageJsonPath = join(fixture.repoRoot, 'apps', 'ui', 'package.json');
    const uiPackageJson = JSON.parse(await readFile(uiPackageJsonPath, 'utf8'));
    await writeFile(uiPackageJsonPath, JSON.stringify({
      ...uiPackageJson,
      dependencies: { ...uiPackageJson.dependencies, '@happier-dev/plugins-fixture': '0.0.1' },
    }));
    await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    assert.match(await readFile(outputPath, 'utf8'), /releaseVersion: "0\.0\.1"/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('one missing plugin artifact is reported while another plugin remains in the published UI inventory', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    await rm(join(fixture.artifactRoot, fixture.relativePath));
    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const output = await readFile(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot), 'utf8');
    assert.match(output, /pluginId: "happier\.second"/);
    assert.doesNotMatch(output, /pluginId: "happier\.fixture"/);
    assert.deepEqual(result.diagnostics.map(({ pluginId, code }) => ({ pluginId, code })), [
      { pluginId: 'happier.fixture', code: 'plugin_ui_artifact_invalid' },
    ]);
    assert.match(result.diagnostics[0].message, /Missing bundled Plugin UI artifact file/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('a package publication failure excludes only that plugin and retains the same diagnostic result', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const failure = Object.freeze({
      packageName: '@happier-dev/plugins-fixture',
      pluginId: 'happier.fixture',
      diagnostic: Object.freeze({ code: 'plugin_package_build_failed', message: 'missing staged export' }),
    });
    const result = await generateBundledPluginUiArtifacts({
      repoRoot: fixture.repoRoot,
      mode: 'write',
      pluginFailures: [failure],
    });
    assert.equal(result.pluginFailures[0], failure);
    const output = await readFile(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot), 'utf8');
    assert.match(output, /pluginId: "happier\.second"/);
    assert.doesNotMatch(output, /pluginId: "happier\.fixture"/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('the UI byte publisher reads the CLI failure set from ignored runtime output', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const failure = {
      packageName: '@happier-dev/plugins-fixture',
      pluginId: 'happier.fixture',
      diagnostic: { code: 'plugin_package_build_failed', message: 'missing staged export' },
    };
    const failurePath = join(
      fixture.repoRoot, 'apps', 'cli', '.project', 'tmp', 'bundled-plugin-publication', 'failures.json',
    );
    await mkdir(dirname(failurePath), { recursive: true });
    await writeFile(failurePath, `${JSON.stringify([failure])}\n`);
    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    const output = await readFile(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot), 'utf8');
    assert.match(output, /pluginId: "happier\.second"/);
    assert.doesNotMatch(output, /pluginId: "happier\.fixture"/);
    assert.deepEqual(result.pluginFailures, [failure]);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('a declared bundle export without an artifact manifest is diagnosed per plugin', async () => {
  const fixture = await createFixture();
  try {
    await addSecondPlugin(fixture.repoRoot);
    const packagePath = join(fixture.repoRoot, 'packages', 'plugins', 'fixture', 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    packageJson.exports = {
      './happier-plugin-ui/react-native/fixture-card/entry.cjs.bundle':
        './dist/happier-plugin-ui/react-native/fixture-card/entry.cjs.bundle',
    };
    await writeFile(packagePath, JSON.stringify(packageJson));
    await rm(join(fixture.artifactRoot, 'ui-artifacts.json'));

    const result = await generateBundledPluginUiArtifacts({ repoRoot: fixture.repoRoot, mode: 'write' });
    assert.deepEqual(result.diagnostics.map(({ pluginId, code }) => ({ pluginId, code })), [
      { pluginId: 'happier.fixture', code: 'plugin_ui_artifact_invalid' },
    ]);
    const output = await readFile(resolveBundledPluginUiArtifactsOutputPath(fixture.repoRoot), 'utf8');
    assert.match(output, /pluginId: "happier\.second"/);
    assert.doesNotMatch(output, /pluginId: "happier\.fixture"/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});
