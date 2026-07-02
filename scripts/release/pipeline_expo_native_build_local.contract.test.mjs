import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const PIPELINE_TEST_TIMEOUT_MS = 120_000;

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo native-build allows local iOS dry-runs without requiring fastlane or cocoapods', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-local-ios-dry-run-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const outJson = path.join(dir, 'out.json');
  const artifactOut = path.join(dir, 'app.ipa');

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/bin/sh',
      'set -eu',
      'echo "NPX $*"',
      'if printf "%s\\n" "$*" | grep -q "fingerprint:generate"; then',
      '  echo \'{"hash":"fp-local-dry-run-test","sources":[],"fileHookTransformConfig":{}}\'',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'ios',
      '--profile',
      'production',
      '--out',
      outJson,
      '--build-mode',
      'local',
      '--artifact-out',
      artifactOut,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: binDir,
        EXPO_TOKEN: 'test-token',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PIPELINE_TEST_TIMEOUT_MS,
    },
  );

  assert.match(stdout, /\[pipeline\] expo native build:/);
  assert.doesNotMatch(stdout, /fastlane is required for local iOS builds/i);
  assert.doesNotMatch(stdout, /cocoapods is required for local iOS builds/i);
  assert.match(stdout, /\[dry-run\].*--local/);
});

test('expo native-build treats local builds as successful when EAS cleanup fails after writing the artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-local-cleanup-noise-'));
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
      'if printf "%s\\n" "$*" | grep -q "fingerprint:generate"; then',
      '  echo \'{"hash":"fp-local-cleanup-test","sources":[],"fileHookTransformConfig":{}}\'',
      '  exit 0',
      'fi',
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
      "echo \"ENOTEMPTY: directory not empty, rmdir '/tmp/eas-local-build/.git'\" >&2",
      'echo "Error: ENOTEMPTY: directory not empty, rmdir \'/tmp/eas-local-build/.git\'" >&2',
      'exit 1',
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
    { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PIPELINE_TEST_TIMEOUT_MS },
  );

  assert.match(stdout, /NPX --yes eas-cli@/);
  assert.ok(fs.existsSync(artifactOut), 'expected local build artifact to be preserved');

  const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(parsed.mode, 'local');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.profile, 'preview-apk');
});
