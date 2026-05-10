import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';
import { expoExec } from './command.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
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
      '  mkdir -p dist',
      "  printf '%s\\n' 'export const ok = true;' > dist/index.js",
      "  printf '%s\\n' 'export const ok = true;' > dist/rpcErrors.js",
      "  printf '%s\\n' 'export declare const ok: boolean;' > dist/index.d.ts",
      "  printf '%s\\n' 'export declare const ok: boolean;' > dist/rpcErrors.d.ts",
      '  exit 0',
      'fi',
      '',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(
    join(binDir, 'yarn.cmd'),
    [
      '@echo off',
      'echo %CD% :: %*>>"%OUTPUT_PATH%"',
      'if "%~1"=="--version" (',
      '  echo 1.22.22',
      '  exit /b 0',
      ')',
      'if "%~1"=="install" exit /b 0',
      'if "%~1"=="-s" if "%~2"=="build" (',
      '  if /I "%CD%"=="' + join(binDir, '..', 'packages', 'protocol') + '" (',
      '    if not exist dist mkdir dist',
      "    >dist\\index.js echo export const ok = true;",
      "    >dist\\rpcErrors.js echo export const ok = true;",
      "    >dist\\index.d.ts echo export declare const ok: boolean;",
      "    >dist\\rpcErrors.d.ts echo export declare const ok: boolean;",
      '  )',
      '  exit /b 0',
      ')',
      'exit /b 0',
    ].join('\r\n') + '\r\n',
    'utf-8',
  );
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
  await writeFile(
    `${expoPath}.cmd`,
    [
      '@echo off',
      'if not exist "..\\..\\packages\\protocol\\dist\\rpcErrors.js" (',
      '  echo missing ..\\..\\packages\\protocol\\dist\\rpcErrors.js 1>&2',
      '  exit /b 3',
      ')',
      'exit /b 0',
    ].join('\r\n') + '\r\n',
    'utf-8',
  );
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
  await writeFile(
    `${expoPath}.cmd`,
    [
      '@echo off',
      'echo expo:cwd=%CD% bin=%~f0 args=%*>>"%OUTPUT_PATH%"',
      'if not exist "..\\..\\packages\\protocol\\dist\\rpcErrors.js" (',
      '  echo missing ..\\..\\packages\\protocol\\dist\\rpcErrors.js 1>&2',
      '  exit /b 3',
      ')',
      'exit /b 0',
    ].join('\r\n') + '\r\n',
    'utf-8',
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  withPatchedProcessEnv(t, {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
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

  withPatchedProcessEnv(t, {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
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
  assert.match(argvLog, /expo:cwd=.*[\\/]apps[\\/]ui\b/);
  assert.match(argvLog, /bin=.*[\\/]node_modules[\\/]\.bin[\\/]expo(?:\.cmd)?\b/);
});
