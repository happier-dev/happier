import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expoExec, expoSpawn } from './command.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeYarnStub({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      '',
      '# Minimal stub: accept install/build without doing work.',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
}

async function writeExpoStubCaptureNodeOptions({ expoPath }) {
  await mkdir(join(expoPath, '..'), { recursive: true });
  await writeFile(
    expoPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      'echo "NODE_OPTIONS=${NODE_OPTIONS:-}" >> "${OUTPUT_PATH:?}"',
      '',
      'expected="${EXPECT_MAX_OLD_SPACE_SIZE:-}"',
      'if [[ -n "$expected" ]]; then',
      '  if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size=${expected}"* ]]; then',
      '    echo "missing --max-old-space-size=${expected} in NODE_OPTIONS=${NODE_OPTIONS:-}" >&2',
      '    exit 11',
      '  fi',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(expoPath, 0o755);
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

async function writeMinimalRepo({ root }) {
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'yarn.lock'), '# lock\n', 'utf-8');
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });
}

test('expoExec defaults Expo heap limit to 8192MB (unless overridden)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-heap-exec-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeMinimalRepo({ root });

  const binDir = join(root, 'bin');
  await writeYarnStub({ binDir });

  const outputPath = join(root, 'node-options.txt');
  await writeFile(outputPath, '', 'utf-8');

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await writeExpoStubCaptureNodeOptions({ expoPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    EXPECT_MAX_OLD_SPACE_SIZE: '8192',
    HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB: null,
    NODE_OPTIONS: null,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['--help'],
    env: process.env,
    quiet: true,
  });

  const logged = await readFile(outputPath, 'utf-8');
  assert.match(logged, /--max-old-space-size=8192/);
});

test('expoExec honors HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB override', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-heap-exec-override-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeMinimalRepo({ root });

  const binDir = join(root, 'bin');
  await writeYarnStub({ binDir });

  const outputPath = join(root, 'node-options.txt');
  await writeFile(outputPath, '', 'utf-8');

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await writeExpoStubCaptureNodeOptions({ expoPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    EXPECT_MAX_OLD_SPACE_SIZE: '4096',
    HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB: '4096',
    NODE_OPTIONS: null,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['--help'],
    env: process.env,
    quiet: true,
  });

  const logged = await readFile(outputPath, 'utf-8');
  assert.match(logged, /--max-old-space-size=4096/);
});

test('expoExec overrides NODE_OPTIONS --max-old-space-size unless explicitly overridden via HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-heap-exec-preserve-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeMinimalRepo({ root });

  const binDir = join(root, 'bin');
  await writeYarnStub({ binDir });

  const outputPath = join(root, 'node-options.txt');
  await writeFile(outputPath, '', 'utf-8');

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await writeExpoStubCaptureNodeOptions({ expoPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    EXPECT_MAX_OLD_SPACE_SIZE: '8192',
    HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB: null,
    NODE_OPTIONS: '--trace-warnings --max-old-space-size=2048',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['--help'],
    env: process.env,
    quiet: true,
  });

  const logged = await readFile(outputPath, 'utf-8');
  assert.match(logged, /--trace-warnings/);
  assert.match(logged, /--max-old-space-size=8192/);
});

test('expoSpawn applies the same heap limit behavior', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-heap-spawn-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeMinimalRepo({ root });

  const binDir = join(root, 'bin');
  await writeYarnStub({ binDir });

  const outputPath = join(root, 'node-options.txt');
  await writeFile(outputPath, '', 'utf-8');

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await writeExpoStubCaptureNodeOptions({ expoPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    EXPECT_MAX_OLD_SPACE_SIZE: '8192',
    HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB: null,
    NODE_OPTIONS: null,
    HAPPIER_STACK_ENV_FILE: null,
  });

  const child = await expoSpawn({
    label: 'expo-test',
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['--help'],
    env: process.env,
    quiet: true,
  });

  await new Promise((resolvePromise, rejectPromise) => {
    child.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`expo exited ${code}`))));
    child.on('error', rejectPromise);
  });

  const logged = await readFile(outputPath, 'utf-8');
  assert.match(logged, /--max-old-space-size=8192/);
});
