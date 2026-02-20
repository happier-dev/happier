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

test('docker publish retries transient buildx failures (EOF) once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-docker-retry-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ buildCalls: 0 }), 'utf8');

  const dockerPath = path.join(binDir, 'docker');
  writeExecutable(
    dockerPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `stateFile=${JSON.stringify(stateFile)}`,
      'read_state() { cat "$stateFile" 2>/dev/null || echo \'{"buildCalls":0}\'; }',
      'write_state() { printf "%s" "$1" >"$stateFile"; }',
      'state="$(read_state)"',
      'buildCalls="$(node -e "const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.buildCalls||0))" "$state")"',
      '',
      'if [ "${1-}" = "info" ]; then',
      '  echo "INFO docker info"',
      '  exit 0',
      'fi',
      'if [ "${1-}" = "login" ]; then',
      '  echo "LOGIN $*"',
      '  cat >/dev/null || true',
      '  exit 0',
      'fi',
      'if [ "${1-}" != "buildx" ]; then echo "unexpected docker subcommand: ${1-}" >&2; exit 1; fi',
      'if [ "${2-}" = "inspect" ]; then',
      '  echo "Driver: docker-container"',
      '  exit 0',
      'fi',
      'if [ "${2-}" = "build" ]; then',
      '  nextCalls=$((buildCalls+1))',
      '  write_state "$(node -e "const s=JSON.parse(process.argv[1]); s.buildCalls=Number(process.argv[2]); process.stdout.write(JSON.stringify(s))" "$state" "$nextCalls")"',
      '  echo "BUILD $*"',
      '  if [ "$nextCalls" = "1" ]; then',
      '    echo "ERROR: failed to build: failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF" >&2',
      '    exit 1',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "${2-}" = "create" ]; then',
      '  echo "CREATE $*"',
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

  const out = execFileSync(
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
      '--build-dev-box',
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

  const buildLines = out.match(/^BUILD\b.*$/gm) ?? [];
  assert.equal(buildLines.length, 2);
});
