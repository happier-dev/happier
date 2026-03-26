import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expoExec } from './command.mjs';

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

async function writeExpoStubCaptureArgs({ expoPath }) {
  await mkdir(join(expoPath, '..'), { recursive: true });
  await writeFile(
    expoPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      'printf "%s\\n" "$@" >> "${OUTPUT_PATH:?}"',
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

async function runExportAndReadArgs({ t, maxWorkersEnv, extraArgs = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'hs-expo-export-max-workers-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeMinimalRepo({ root });

  const binDir = join(root, 'bin');
  await writeYarnStub({ binDir });

  const outputPath = join(root, 'expo-args.txt');
  await writeFile(outputPath, '', 'utf-8');

  const expoPath = join(root, 'node_modules', '.bin', 'expo');
  await writeExpoStubCaptureArgs({ expoPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: maxWorkersEnv,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await expoExec({
    dir: root,
    projectDir: join(root, 'apps', 'ui'),
    args: ['export', '--platform', 'web', '--output-dir', 'dist', ...extraArgs],
    env: process.env,
    quiet: true,
  });

  const raw = await readFile(outputPath, 'utf-8');
  const lines = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { root, lines };
}

test('expoExec injects --max-workers from HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS', async (t) => {
  const { lines } = await runExportAndReadArgs({ t, maxWorkersEnv: '2' });
  assert.ok(lines.includes('--max-workers'));
  const idx = lines.indexOf('--max-workers');
  assert.equal(lines[idx + 1], '2');
});

test('expoExec does not inject --max-workers when explicitly disabled via HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS=0', async (t) => {
  const { lines } = await runExportAndReadArgs({ t, maxWorkersEnv: '0' });
  assert.ok(!lines.includes('--max-workers'));
});

test('expoExec does not override an explicit --max-workers flag passed by the caller', async (t) => {
  const { lines } = await runExportAndReadArgs({ t, maxWorkersEnv: '2', extraArgs: ['--max-workers', '5'] });
  const occurrences = lines.filter((l) => l === '--max-workers').length;
  assert.equal(occurrences, 1);
  const idx = lines.indexOf('--max-workers');
  assert.equal(lines[idx + 1], '5');
});
