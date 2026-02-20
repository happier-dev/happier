import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo native-build supports local mode and writes build metadata json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-local-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const outJson = path.join(dir, 'out.json');
  const artifactOut = path.join(dir, 'app.apk');

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "CWD=$(pwd)"',
      'if [ ! -d "../../.git" ]; then echo "MISSING_GIT_REPO" >&2; exit 1; fi',
      'if [ ! -e "../../node_modules" ]; then echo "MISSING_NODE_MODULES" >&2; exit 1; fi',
      'if [ ! -e "./node_modules" ]; then echo "MISSING_UI_NODE_MODULES" >&2; exit 1; fi',
      'echo "NPX $*"',
      // Simulate `eas build --local --output <path>` by creating the output file.
      'out=""',
      'for ((i=1;i<=$#;i++)); do',
      '  if [ "${!i}" = "--output" ]; then',
      '    j=$((i+1))',
      '    out="${!j}"',
      '  fi',
      'done',
      'if [ -z "${out}" ]; then echo "missing --output" >&2; exit 1; fi',
      'mkdir -p "$(dirname "${out}")"',
      'head -c 1000001 /dev/zero > "${out}"',
      'exit 0',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    EXPO_TOKEN: 'test-token',
  };

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--out',
      outJson,
      '--build-mode',
      'local',
      '--artifact-out',
      artifactOut,
    ],
    { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(stdout, /\[pipeline\] expo native build:/);
  assert.match(stdout, /CWD=.*happier-pipeline-dagger-repo-.*\/apps\/ui\b/);
  assert.match(stdout, /NPX --yes eas-cli@/);
  assert.match(stdout, /\s--local\b/);
  assert.match(stdout, /\s--non-interactive\b/);
  assert.ok(fs.existsSync(artifactOut), 'expected local build artifact to be created');

  const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(parsed.mode, 'local');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.profile, 'preview-apk');
  assert.equal(path.resolve(parsed.artifactPath), path.resolve(artifactOut));
});

test('expo native-build runs local builds non-interactively in CI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-local-ci-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const outJson = path.join(dir, 'out.json');
  const artifactOut = path.join(dir, 'app.apk');

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "NPX $*"',
      // Simulate `eas build --local --output <path>` by creating the output file.
      'out=""',
      'for ((i=1;i<=$#;i++)); do',
      '  if [ "${!i}" = "--output" ]; then',
      '    j=$((i+1))',
      '    out="${!j}"',
      '  fi',
      'done',
      'if [ -z "${out}" ]; then echo "missing --output" >&2; exit 1; fi',
      'mkdir -p "$(dirname "${out}")"',
      'head -c 1000001 /dev/zero > "${out}"',
      'exit 0',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    EXPO_TOKEN: 'test-token',
    CI: 'true',
  };

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--out',
      outJson,
      '--build-mode',
      'local',
      '--artifact-out',
      artifactOut,
    ],
    { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(stdout, /NPX --yes eas-cli@/);
  assert.match(stdout, /\s--local\b/);
  assert.match(stdout, /\s--non-interactive\b/);
});

test('expo native-build allows interactive local builds when PIPELINE_INTERACTIVE=1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-local-interactive-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const outJson = path.join(dir, 'out.json');
  const artifactOut = path.join(dir, 'app.apk');

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "NPX $*"',
      // Simulate `eas build --local --output <path>` by creating the output file.
      'out=""',
      'for ((i=1;i<=$#;i++)); do',
      '  if [ "${!i}" = "--output" ]; then',
      '    j=$((i+1))',
      '    out="${!j}"',
      '  fi',
      'done',
      'if [ -z "${out}" ]; then echo "missing --output" >&2; exit 1; fi',
      'mkdir -p "$(dirname "${out}")"',
      'head -c 1000001 /dev/zero > "${out}"',
      'exit 0',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    EXPO_TOKEN: 'test-token',
    PIPELINE_INTERACTIVE: '1',
  };

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--out',
      outJson,
      '--build-mode',
      'local',
      '--artifact-out',
      artifactOut,
    ],
    { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(stdout, /NPX --yes eas-cli@/);
  assert.match(stdout, /\s--local\b/);
  assert.doesNotMatch(stdout, /\s--non-interactive\b/);
});
