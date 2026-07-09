import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expoExec } from './command.mjs';

const execFileAsync = promisify(execFile);

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function createTarGz({ rootDir, archivePath, files }) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(rootDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf-8');
  }
  await execFileAsync('tar', ['-czf', archivePath, '-C', rootDir, '.']);
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function writeYarnStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$(pwd) :: $*" >> "${OUTPUT_PATH:?}"',
      '',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      '',
      'if [[ "${1:-}" == "install" ]]; then',
      '  exit 0',
      'fi',
      '',
      'if [[ "${1:-}" == "-s" && "${2:-}" == "build" && "$(pwd)" == */packages/protocol ]]; then',
      '  out_dir="${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-dist}"',
      '  mkdir -p "$out_dir"',
      "  printf '%s\\n' 'export const ok = true;' > \"$out_dir/index.js\"",
      "  printf '%s\\n' 'export const ok = true;' > \"$out_dir/rpcErrors.js\"",
      "  printf '%s\\n' 'export declare const ok: boolean;' > \"$out_dir/index.d.ts\"",
      "  printf '%s\\n' 'export declare const ok: boolean;' > \"$out_dir/rpcErrors.d.ts\"",
      '  exit 0',
      'fi',
      '',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeExpoStub({ expoPath }) {
  await mkdir(join(expoPath, '..'), { recursive: true });
  await writeFile(
    expoPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      '# Fail if protocol dist output is missing (simulates Metro failing on exports->dist targets).',
      'if [[ ! -f "../../packages/protocol/dist/rpcErrors.js" ]]; then',
      '  echo "missing ../../packages/protocol/dist/rpcErrors.js" >&2',
      '  exit 3',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(expoPath, 0o755);
}

async function writeExpoStubCaptureCwd({ expoPath }) {
  await mkdir(join(expoPath, '..'), { recursive: true });
  await writeFile(
    expoPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      'echo "expo:cwd=$(pwd) bin=$0 args=$*" >> "${OUTPUT_PATH:?}"',
      '',
      '# Fail if protocol dist output is missing (simulates Metro failing on exports->dist targets).',
      'if [[ ! -f "../../packages/protocol/dist/rpcErrors.js" ]]; then',
      '  echo "missing ../../packages/protocol/dist/rpcErrors.js" >&2',
      '  exit 3',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(expoPath, 0o755);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyEnvOverrides(t, vars) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(vars)) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
}

test('expoExec builds workspace dist deps for the projectDir (not the runnerDir)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-workspace-deps-built-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Minimal Happy monorepo markers.
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'yarn.lock'), '# lock\n', 'utf-8');

  // Root does NOT depend on protocol; only apps/ui does.
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(protocolDir, { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './rpcErrors': { default: './dist/rpcErrors.js', types: './dist/rpcErrors.d.ts' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnStub({ binDir, outputPath });

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await writeExpoStub({ expoPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['export', '--platform', 'web', '--output-dir', join(root, 'out')],
    env: process.env,
    ensureDepsLabel: 'happy',
    quiet: true,
  });

  const argvLog = await readFile(outputPath, 'utf-8');
  // The stubbed yarn writes all invocations to OUTPUT_PATH; we assert that protocol build ran.
  assert.match(
    argvLog,
    new RegExp(`${escapeRegExp(join(root, 'packages', 'protocol'))} :: -s build`),
  );
});

test('expoExec falls back to the monorepo root expo bin when runnerDir lacks node_modules/.bin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-root-bin-fallback-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Minimal Happy monorepo markers.
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'yarn.lock'), '# lock\n', 'utf-8');

  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    dependencies: {
      '@happier-dev/protocol': '0.0.0',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(protocolDir, { recursive: true });
  await writeJson(join(protocolDir, 'package.json'), {
    name: '@happier-dev/protocol',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './rpcErrors': { default: './dist/rpcErrors.js', types: './dist/rpcErrors.d.ts' },
    },
    scripts: { build: 'tsc -p tsconfig.json' },
  });
  await writeJson(join(protocolDir, 'tsconfig.json'), { compilerOptions: { outDir: 'dist' } });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnStub({ binDir, outputPath });

  // Only place the expo binary at the monorepo root.
  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await writeExpoStubCaptureCwd({ expoPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await expoExec({
    dir: join(root, 'apps', 'ui'),
    projectDir: join(root, 'apps', 'ui'),
    args: ['export', '--platform', 'web', '--output-dir', join(root, 'out')],
    env: process.env,
    ensureDepsLabel: 'happy',
    quiet: true,
  });

  const argvLog = await readFile(outputPath, 'utf-8');
  assert.match(argvLog, /expo:cwd=/);
  // macOS can report tmp paths via `/private/var/...` even if `mkdtemp()` returns `/var/...`.
  // Only assert stable suffixes.
  assert.match(argvLog, /expo:cwd=.*\/apps\/ui\b/);
  assert.match(argvLog, /bin=.*\/node_modules\/\.bin\/expo\b/);
});

test('expoExec repairs Yarn shell shims inside Expo package bin files before invoking Expo', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-bin-shims-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });
  await writeFile(join(root, 'yarn.lock'), '# lock\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnStub({ binDir, outputPath });

  const expoPackageDir = join(root, 'apps', 'ui', 'node_modules', 'expo');
  await mkdir(join(expoPackageDir, 'bin'), { recursive: true });
  await writeJson(join(expoPackageDir, 'package.json'), {
    name: 'expo',
    bin: {
      expo: 'bin/cli',
      'expo-modules-autolinking': 'bin/autolinking',
      fingerprint: 'bin/fingerprint',
    },
  });
  for (const name of ['cli', 'autolinking', 'fingerprint']) {
    const path = join(expoPackageDir, 'bin', name);
    await writeFile(path, '#!/bin/sh\necho corrupted-expo-shim >&2\nexit 42\n', 'utf-8');
    await chmod(path, 0o755);
  }

  const autolinkingPackageDir = join(root, 'node_modules', 'expo-modules-autolinking');
  await mkdir(join(autolinkingPackageDir, 'bin'), { recursive: true });
  await writeJson(join(autolinkingPackageDir, 'package.json'), {
    name: 'expo-modules-autolinking',
    bin: { 'expo-modules-autolinking': 'bin/expo-modules-autolinking.js' },
  });
  const autolinkingBin = join(autolinkingPackageDir, 'bin', 'expo-modules-autolinking.js');
  await writeFile(autolinkingBin, '#!/bin/sh\necho corrupted-autolinking-shim >&2\nexit 42\n', 'utf-8');
  await chmod(autolinkingBin, 0o755);

  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await symlink('../../apps/ui/node_modules/expo/bin/cli', join(root, 'node_modules', '.bin', 'expo'));

  await mkdir(join(root, 'node_modules', '@expo', 'cli'), { recursive: true });
  await writeJson(join(root, 'node_modules', '@expo', 'cli', 'package.json'), {
    name: '@expo/cli',
    main: 'index.js',
  });
  await writeFile(
    join(root, 'node_modules', '@expo', 'cli', 'index.js'),
    'require("node:fs").appendFileSync(process.env.OUTPUT_PATH, "cli-loaded\\n");\n',
    'utf-8',
  );

  applyEnvOverrides(t, {
    PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['--version'],
    env: process.env,
    ensureDepsLabel: 'happy',
    quiet: true,
  });

  const argvLog = await readFile(outputPath, 'utf-8');
  assert.match(argvLog, /cli-loaded/);
  assert.match(await readFile(join(expoPackageDir, 'bin', 'cli'), 'utf-8'), /^#!\/usr\/bin\/env node/);
  assert.match(await readFile(join(expoPackageDir, 'bin', 'autolinking'), 'utf-8'), /expo-modules-autolinking/);
  assert.match(await readFile(autolinkingBin, 'utf-8'), /require\('\.\.\/build'\)/);
});

test('expoExec restores missing React Native Skia iOS binaries before Expo iOS runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-skia-ios-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });
  await writeFile(join(root, 'yarn.lock'), '# lock\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnStub({ binDir, outputPath });

  const skiaPackageDir = join(root, 'apps', 'ui', 'node_modules', '@shopify', 'react-native-skia');
  await mkdir(join(skiaPackageDir, 'scripts'), { recursive: true });
  await writeJson(join(skiaPackageDir, 'package.json'), { name: '@shopify/react-native-skia', skia: { version: 'm999' } });
  await writeFile(
    join(skiaPackageDir, 'scripts', 'install-skia.mjs'),
    'throw new Error("all-platform installer should not run");\n',
    'utf-8',
  );
  const skiaAssetsDir = join(root, 'skia-assets');
  const skiaReleaseDir = join(skiaAssetsDir, 'skia-m999');
  const skiaArchiveRoot = join(root, 'skia-archive-root');
  await mkdir(skiaReleaseDir, { recursive: true });
  await createTarGz({
    rootDir: skiaArchiveRoot,
    archivePath: join(skiaReleaseDir, 'skia-apple-ios-xcframeworks-skia-m999.tar.gz'),
    files: {
      'skia-apple-ios-xcframeworks/ios/libskia.xcframework/marker.txt': 'installed',
    },
  });

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await mkdir(join(expoPath, '..'), { recursive: true });
  await writeFile(
    expoPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'test -f "node_modules/@shopify/react-native-skia/libs/apple/ios/libskia.xcframework/marker.txt"',
      'echo "expo-ios-ran" >> "${OUTPUT_PATH:?}"',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(expoPath, 0o755);

  applyEnvOverrides(t, {
    PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_STACK_SKIA_RELEASE_BASE_URL: pathToFileURL(skiaAssetsDir).href,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['run:ios'],
    env: process.env,
    ensureDepsLabel: 'happy',
    quiet: true,
  });

  const argvLog = await readFile(outputPath, 'utf-8');
  assert.match(argvLog, /expo-ios-ran/);
});

test('expoExec restores missing React Native Skia Android binaries before Expo Android runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-skia-android-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });
  await writeFile(join(root, 'yarn.lock'), '# lock\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnStub({ binDir, outputPath });

  const skiaPackageDir = join(root, 'apps', 'ui', 'node_modules', '@shopify', 'react-native-skia');
  await mkdir(join(skiaPackageDir, 'scripts'), { recursive: true });
  await writeJson(join(skiaPackageDir, 'package.json'), { name: '@shopify/react-native-skia', skia: { version: 'm999' } });
  await writeFile(
    join(skiaPackageDir, 'scripts', 'install-skia.mjs'),
    'throw new Error("all-platform installer should not run");\n',
    'utf-8',
  );
  const skiaAssetsDir = join(root, 'skia-assets');
  const skiaReleaseDir = join(skiaAssetsDir, 'skia-m999');
  const skiaArchiveRoot = join(root, 'skia-archive-root');
  await mkdir(skiaReleaseDir, { recursive: true });
  await createTarGz({
    rootDir: skiaArchiveRoot,
    archivePath: join(skiaReleaseDir, 'skia-android-arm-64-skia-m999.tar.gz'),
    files: {
      'skia-android-arm-64/arm64-v8a/libskia.a': 'installed',
    },
  });

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await mkdir(join(expoPath, '..'), { recursive: true });
  await writeFile(
    expoPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'test -f "node_modules/@shopify/react-native-skia/libs/android/arm64-v8a/libskia.a"',
      'echo "expo-android-ran" >> "${OUTPUT_PATH:?}"',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(expoPath, 0o755);

  applyEnvOverrides(t, {
    PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_ANDROID_BUILD_ARCHS: 'arm64-v8a',
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_STACK_SKIA_RELEASE_BASE_URL: pathToFileURL(skiaAssetsDir).href,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['run:android'],
    env: process.env,
    ensureDepsLabel: 'happy',
    quiet: true,
  });

  const argvLog = await readFile(outputPath, 'utf-8');
  assert.match(argvLog, /expo-android-ran/);
});

test('expoExec restores missing React Native libsodium native build before Expo iOS runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-libsodium-ios-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });
  await writeFile(join(root, 'yarn.lock'), '# lock\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnStub({ binDir, outputPath });

  const packageDir = join(root, 'apps', 'ui', 'node_modules', '@more-tech', 'react-native-libsodium');
  const stagedBuildDir = join(root, 'staged-libsodium-build');
  await mkdir(join(packageDir, 'libsodium'), { recursive: true });
  await mkdir(join(stagedBuildDir, 'build', 'libsodium-apple', 'Clibsodium.xcframework'), { recursive: true });
  await mkdir(join(stagedBuildDir, 'build', 'libsodium-ios', 'include'), { recursive: true });
  await writeJson(join(packageDir, 'package.json'), { name: '@more-tech/react-native-libsodium' });
  await writeFile(join(stagedBuildDir, 'build', 'libsodium-ios', 'include', 'sodium.h'), '/* sodium */\n', 'utf-8');
  await writeFile(
    join(stagedBuildDir, 'build', 'libsodium-apple', 'Clibsodium.xcframework', 'marker.txt'),
    'installed',
    'utf-8',
  );
  await execFileAsync('tar', ['-czf', join(packageDir, 'libsodium', 'build.tgz'), '-C', stagedBuildDir, 'build']);

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await mkdir(join(expoPath, '..'), { recursive: true });
  await writeFile(
    expoPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "expo-ios-ran" >> "${OUTPUT_PATH:?}"',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(expoPath, 0o755);

  applyEnvOverrides(t, {
    PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['run:ios'],
    env: process.env,
    ensureDepsLabel: 'happy',
    quiet: true,
  });

  const argvLog = await readFile(outputPath, 'utf-8');
  assert.match(argvLog, /expo-ios-ran/);
  assert.equal(await fileExists(join(packageDir, 'libsodium', 'build', 'libsodium-ios', 'include', 'sodium.h')), true);
  assert.equal(
    await fileExists(join(packageDir, 'libsodium', 'build', 'libsodium-apple', 'Clibsodium.xcframework', 'marker.txt')),
    true,
  );
});
