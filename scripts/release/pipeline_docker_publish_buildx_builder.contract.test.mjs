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

function runPublishImagesWithFakeDocker({ inspectDriver, fallbackExists }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-docker-builder-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const dockerPath = path.join(binDir, 'docker');
  writeExecutable(
    dockerPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1-}" = "info" ]; then',
      '  echo "INFO docker info"',
      '  exit 0',
      'fi',
      'if [ "${1-}" = "login" ]; then',
      '  echo "LOGIN $*"',
      '  # allow callers to use --password-stdin',
      '  cat >/dev/null || true',
      '  exit 0',
      'fi',
      'if [ "${1-}" != "buildx" ]; then echo "unexpected docker subcommand: ${1-}" >&2; exit 1; fi',
      'if [ "${2-}" = "inspect" ]; then',
      '  name="${3-}"',
      `  if [ "${fallbackExists ? 'true' : 'false'}" != "true" ] && [ "$name" = "happier-multiarch-docker-container" ]; then exit 1; fi`,
      `  echo "Driver: ${inspectDriver}"`,
      '  exit 0',
      'fi',
      'if [ "${2-}" = "create" ]; then',
      '  echo "CREATE $*"',
      '  exit 0',
      'fi',
      'if [ "${2-}" = "build" ]; then',
      '  echo "BUILD $*"',
      '  exit 0',
      'fi',
      'echo "unexpected buildx subcommand: ${2-}" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    DOCKERHUB_USERNAME: 'happierdev',
    DOCKERHUB_TOKEN: 'docker-token',
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  return execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'docker', 'publish-images.mjs'),
      '--channel',
      'preview',
      '--sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--push-latest',
      'false',
      '--build-relay',
      'true',
      '--build-devcontainer',
      'false',
    ],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
}

test('docker publish uses the existing docker-container buildx builder when available', () => {
  const out = runPublishImagesWithFakeDocker({ inspectDriver: 'docker-container', fallbackExists: true });
  assert.match(out, /\[pipeline\] docker preflight:/);
  assert.match(out, /LOGIN login\b/);
  assert.match(out, /BUILD buildx build\b/);
  assert.match(out, /--builder happier-multiarch\b/);
  assert.doesNotMatch(out, /CREATE buildx create\b/);
});

test('docker publish creates a docker-container buildx builder when current builder driver is docker', () => {
  const out = runPublishImagesWithFakeDocker({ inspectDriver: 'docker', fallbackExists: false });
  assert.match(out, /\[pipeline\] docker preflight:/);
  assert.match(out, /LOGIN login\b/);
  assert.match(out, /CREATE buildx create\b/);
  assert.match(out, /--driver docker-container\b/);
  assert.match(out, /--name happier-multiarch-docker-container\b/);
  assert.match(out, /BUILD buildx build\b/);
  assert.match(out, /--builder happier-multiarch-docker-container\b/);
  assert.doesNotMatch(out, /\s--use\b/);
});
