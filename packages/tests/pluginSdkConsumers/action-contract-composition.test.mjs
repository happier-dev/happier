import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runCommand } from './run-probes.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const fixtureProducerRoot = join(
  repoRoot,
  'packages/tests/fixtures/plugin-platform/action-contract-producer',
);
const fixtureConsumerRoot = join(
  repoRoot,
  'packages/tests/fixtures/plugin-platform/action-contract-consumer',
);
const exampleProducerRoot = join(
  repoRoot,
  'packages/plugin-sdk/examples/action-contract-producer',
);
const exampleConsumerRoot = join(
  repoRoot,
  'packages/plugin-sdk/examples/action-contract-consumer',
);
const require = createRequire(import.meta.url);
const nativeTypeScriptPlatformPackageName =
  `@typescript/typescript-${process.platform}-${process.arch}`;
const nativeTypeScriptPlatformPackageRoot = dirname(
  require.resolve(`${nativeTypeScriptPlatformPackageName}/package.json`),
);

function oneTarball(packDir, label) {
  return readdir(packDir).then((entries) => {
    const tarballs = entries.filter((entry) => entry.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, `${label} pack must produce one tarball`);
    return join(packDir, tarballs[0]);
  });
}

function pack(packageDir, packDir, label) {
  return (async () => {
    await runCommand('npm', [
      'pack',
      '--ignore-scripts',
      '--silent',
      '--pack-destination',
      packDir,
    ], {
      cwd: packageDir,
      stage: `pack-${label}`,
      timeout: 180_000,
    });
    return await oneTarball(packDir, label);
  })();
}

async function buildAuthorProject(projectDir, label, happierHomeDir) {
  await runCommand(process.execPath, [
    join(repoRoot, 'apps/cli/bin/happier.mjs'),
    'plugins',
    'dev',
    'build',
    projectDir,
  ], {
    cwd: projectDir,
    env: { HAPPIER_HOME_DIR: happierHomeDir },
    stage: `author-build-${label}`,
    timeout: 240_000,
  });
}

async function prepareManagedJavaScriptRuntime(happierHomeDir) {
  const runtimeRoot = join(happierHomeDir, 'tools', 'js-runtime', 'current');
  const wrapperPath = join(
    runtimeRoot,
    'bin',
    process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime',
  );
  const runtimePath = process.platform === 'win32'
    ? join(runtimeRoot, 'runtime', 'node.exe')
    : join(runtimeRoot, 'runtime', 'bin', 'node');
  await mkdir(dirname(wrapperPath), { recursive: true });
  await mkdir(dirname(runtimePath), { recursive: true });
  if (process.platform === 'win32') {
    await copyFile(process.execPath, runtimePath);
    await writeFile(wrapperPath, '@echo off\r\n"%~dp0..\\runtime\\node.exe" %*\r\n', 'utf8');
    return;
  }
  await symlink(process.execPath, runtimePath);
  await writeFile(wrapperPath, '#!/bin/sh\nexec "${0%/*}/../runtime/bin/node" "$@"\n', 'utf8');
  await chmod(wrapperPath, 0o755);
}

async function linkNativeTypeScriptToolchain(projectDir) {
  await copyWorkspacePackage(
    projectDir,
    '@typescript/native',
    join(repoRoot, 'node_modules/@typescript/native'),
  );
  await copyWorkspacePackage(
    projectDir,
    nativeTypeScriptPlatformPackageName,
    nativeTypeScriptPlatformPackageRoot,
  );
}

async function prepareCurrentAuthorSourceLayout(projectDir, fixtureSourceEntrypoint) {
  if (!fixtureSourceEntrypoint) return;
  const currentEntrypoint = join(projectDir, 'src/index.ts');
  try {
    await readFile(currentEntrypoint, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await cp(join(projectDir, fixtureSourceEntrypoint), currentEntrypoint);
  }
  const tsconfigPath = join(projectDir, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'));
  tsconfig.compilerOptions = {
    ...tsconfig.compilerOptions,
    noEmit: true,
  };
  await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, 'utf8');
}

async function linkWorkspacePackage(projectDir, packageName, packageRoot) {
  const packagePath = join(projectDir, 'node_modules', ...packageName.split('/'));
  await mkdir(dirname(packagePath), { recursive: true });
  await symlink(packageRoot, packagePath, 'dir');
}

async function copyWorkspacePackage(projectDir, packageName, packageRoot) {
  const packagePath = join(projectDir, 'node_modules', ...packageName.split('/'));
  await mkdir(dirname(packagePath), { recursive: true });
  await cp(packageRoot, packagePath, { recursive: true });
}

async function extractPackedPackage(tarballPath, targetRoot) {
  const unpackRoot = join(targetRoot, '.unpack');
  await mkdir(unpackRoot, { recursive: true });
  await runCommand('tar', ['-xzf', tarballPath, '-C', unpackRoot], {
    cwd: targetRoot,
    stage: 'extract-packed-package',
    timeout: 30_000,
  });
  const packageJson = JSON.parse(await readFile(join(unpackRoot, 'package/package.json'), 'utf8'));
  const packageSegments = packageJson.name.split('/');
  const packagePath = packageJson.name.startsWith('@')
    ? join(targetRoot, 'node_modules', packageSegments[0])
    : join(targetRoot, 'node_modules');
  await mkdir(packagePath, { recursive: true });
  const targetPath = join(packagePath, packageSegments.at(-1));
  await rm(targetPath, { recursive: true, force: true });
  await cp(join(unpackRoot, 'package'), targetPath, { recursive: true });
  await rm(unpackRoot, { recursive: true, force: true });
  return targetPath;
}

async function buildBrowserActionGraph(producerDir, producerPluginId) {
  const configPath = join(producerDir, 'vite.action-contract.config.mjs');
  await writeFile(configPath, [
    'export default {',
    '  logLevel: "error",',
    '  build: {',
    '    emptyOutDir: true,',
    '    lib: { entry: "dist/actions/index.js", formats: ["es"], fileName: "actions" },',
    '    outDir: "browser-dist",',
    '  },',
    '};',
    '',
  ].join('\n'), 'utf8');
  await runCommand(process.execPath, [
    join(repoRoot, 'node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    configPath,
  ], {
    cwd: producerDir,
    stage: 'browser-action-graph',
    timeout: 180_000,
  });
  const output = await readFile(join(producerDir, 'browser-dist/actions.js'), 'utf8');
  const escapedPluginId = producerPluginId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  assert.match(output, new RegExp(escapedPluginId, 'u'));
  assert.match(output, /Object\.freeze/u);
  assert.doesNotMatch(output, /inputSchema|resultSchema|zod|plugin\.js/u);
}

async function runPackedComposition(input) {
  const {
    producerRoot,
    consumerRoot,
    producerPackageName,
    consumerPackageName,
    producerPluginId,
    producerRuntimeEntry,
    producerFixtureSourceEntrypoint,
  } = input;
  const workDir = await mkdtemp(join(tmpdir(), 'happier-action-contract-composition-'));
  try {
    const producerPackDir = join(workDir, 'producer-pack');
    const consumerPackDir = join(workDir, 'consumer-pack');
    const runtimeDir = join(workDir, 'runtime');
    await Promise.all([
      cp(producerRoot, join(workDir, 'producer'), { recursive: true }),
      cp(consumerRoot, join(workDir, 'consumer'), { recursive: true }),
    ]);
    await Promise.all([
      mkdir(join(workDir, 'producer', 'dist'), { recursive: true }),
      mkdir(join(workDir, 'consumer', 'dist'), { recursive: true }),
    ]);
    await Promise.all([
      mkdir(producerPackDir, { recursive: true }),
      mkdir(consumerPackDir, { recursive: true }),
      mkdir(runtimeDir, { recursive: true }),
    ]);

    const producerDir = join(workDir, 'producer');
    const consumerDir = join(workDir, 'consumer');
    const happierHomeDir = join(workDir, 'happier-home');
    await prepareManagedJavaScriptRuntime(happierHomeDir);
    await prepareCurrentAuthorSourceLayout(producerDir, producerFixtureSourceEntrypoint);
    // The package pair is external to the workspace. Link only the incumbent
    // SDK package for compilation; producer and consumer are still packed and
    // installed below as independent package boundaries.
    await linkWorkspacePackage(producerDir, '@happier-dev/plugin-sdk', join(repoRoot, 'packages/plugin-sdk'));
    await linkWorkspacePackage(
      producerDir,
      '@types/node',
      join(repoRoot, 'packages/plugin-sdk/node_modules/@types/node'),
    );
    await linkNativeTypeScriptToolchain(producerDir);
    await buildAuthorProject(producerDir, 'producer', happierHomeDir);

    const producerDeclaration = await readFile(join(producerDir, 'dist/plugin.d.ts'), 'utf8');
    assert.doesNotMatch(producerDeclaration, /targetedContributionPointEvidence/u);

    const producerTarball = await pack(producerDir, producerPackDir, 'producer');
    await linkWorkspacePackage(consumerDir, '@happier-dev/plugin-sdk', join(repoRoot, 'packages/plugin-sdk'));
    await linkWorkspacePackage(
      consumerDir,
      '@types/node',
      join(repoRoot, 'packages/plugin-sdk/node_modules/@types/node'),
    );
    await extractPackedPackage(producerTarball, consumerDir);
    await linkNativeTypeScriptToolchain(consumerDir);
    await buildAuthorProject(consumerDir, 'consumer', happierHomeDir);

    const generatedActionRuntime = await readFile(
      join(producerDir, 'dist/actions/index.js'),
      'utf8',
    );
    assert.doesNotMatch(generatedActionRuntime, /from ['"].*plugin(?:\.js)?['"]/u);
    assert.doesNotMatch(generatedActionRuntime, /inputSchema|resultSchema|zod/u);
    assert.match(generatedActionRuntime, /["']archive["']/u);
    const generatedActionTypes = await readFile(
      join(producerDir, 'dist/actions/index.d.ts'),
      'utf8',
    );
    assert.match(generatedActionTypes, /typeof import\(["']\.\.\/(?:index|plugin)\.js["']\)\.actionContracts/u);
    assert.match(generatedActionTypes, /export type \{ ActionContract \} from ['"]@happier-dev\/plugin-sdk\/actions['"]/u);
    const consumerSource = await readFile(join(consumerDir, 'src/index.ts'), 'utf8');
    const escapedProducerPackageName = producerPackageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    assert.match(consumerSource, new RegExp(`${escapedProducerPackageName}/actions`, 'u'));
    assert.doesNotMatch(consumerSource, new RegExp(`${escapedProducerPackageName}['"]`, 'u'));
    await buildBrowserActionGraph(producerDir, producerPluginId);

    const consumerTarball = await pack(consumerDir, consumerPackDir, 'consumer');
    await writeFile(join(runtimeDir, 'package.json'), JSON.stringify({
      name: 'action-contract-composition-runtime',
      private: true,
      type: 'module',
    }, null, 2), 'utf8');
    await linkWorkspacePackage(runtimeDir, '@happier-dev/plugin-sdk', join(repoRoot, 'packages/plugin-sdk'));
    await linkWorkspacePackage(runtimeDir, '@happier-dev/protocol', join(repoRoot, 'packages/protocol'));
    await extractPackedPackage(producerTarball, runtimeDir);
    await extractPackedPackage(consumerTarball, runtimeDir);
    const producer = await import(join(
      runtimeDir,
      'node_modules',
      ...producerPackageName.split('/'),
      producerRuntimeEntry,
    ));
    const consumer = await import(join(
      runtimeDir,
      'node_modules',
      ...consumerPackageName.split('/'),
      'dist/index.js',
    ));
    const { createPluginTestkit } = await import(
      join(runtimeDir, 'node_modules/@happier-dev/plugin-sdk/dist/testing/index.js'),
    );
    const producerTestkit = await createPluginTestkit({
      manifest: producer.manifest,
      module: { activate: producer.activate },
    });
    const consumerTestkit = await createPluginTestkit({
      manifest: consumer.manifest,
      module: { activate: consumer.activate },
      actionTargets: [producerTestkit],
    });
    try {
      const result = await consumerTestkit.invokeAction('invoke', {
        title: 'Publish from the consumer',
      }, { surface: 'plugin' });
      assert.deepEqual({ ...result }, {
        accepted: true,
        executeTitle: 'Publish from the consumer:execute',
        originTitle: 'Publish from the consumer:origin',
        targetPluginId: producerPluginId,
      });
    } finally {
      await consumerTestkit.dispose();
      await producerTestkit.dispose();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

test('independently packed producer/consumer fixture composes through public ./actions only', async () => {
  await runPackedComposition({
    producerRoot: fixtureProducerRoot,
    consumerRoot: fixtureConsumerRoot,
    producerPackageName: '@happier-dev/action-contract-producer-fixture',
    consumerPackageName: '@happier-dev/action-contract-consumer-fixture',
    producerPluginId: 'fixture.action-contract-producer',
    producerRuntimeEntry: 'dist/plugin.js',
    producerFixtureSourceEntrypoint: 'src/plugin.ts',
  });
});

test('copyable example producer/consumer composes through normal plugin activation', async () => {
  await runPackedComposition({
    producerRoot: exampleProducerRoot,
    consumerRoot: exampleConsumerRoot,
    producerPackageName: '@example/happier-action-contract-producer',
    consumerPackageName: '@example/happier-action-contract-consumer',
    producerPluginId: 'examples.action-contract-producer',
    producerRuntimeEntry: 'dist/index.js',
  });
});
