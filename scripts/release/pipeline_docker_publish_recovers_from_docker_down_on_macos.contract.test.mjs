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

test('docker publish attempts to start Docker Desktop on macOS when docker info fails', () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-docker-preflight-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ infoCalls: 0 }), 'utf8');

  const dockerPath = path.join(binDir, 'docker');
  writeExecutable(
    dockerPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `stateFile=${JSON.stringify(stateFile)}`,
      'state="$(cat "$stateFile" 2>/dev/null || echo \'{"infoCalls":0}\')"',
      'infoCalls="$(node -e "const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.infoCalls||0))" "$state")"',
      '',
      'if [ "${1-}" = "info" ]; then',
      '  next=$((infoCalls+1))',
      '  node -e "const fs=require(\'fs\'); const p=process.argv[1]; const s=JSON.parse(fs.readFileSync(p,\'utf8\')); s.infoCalls=Number(process.argv[2]); fs.writeFileSync(p, JSON.stringify(s));" "$stateFile" "$next"',
      '  if [ "$next" = "1" ]; then',
      '    echo "Cannot connect to the Docker daemon at unix:///Users/example/.docker/run/docker.sock. Is the docker daemon running?" >&2',
      '    exit 1',
      '  fi',
      '  echo "INFO ok"',
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
      '  echo "BUILD $*"',
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

  const openPath = path.join(binDir, 'open');
  writeExecutable(
    openPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "OPEN $*"',
      'exit 0',
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

  assert.match(out, /\bOPEN -a Docker\b/);
  assert.match(out, /^BUILD\b/m);
});

