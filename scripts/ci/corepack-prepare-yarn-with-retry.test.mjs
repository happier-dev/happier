import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(repoRoot, 'scripts', 'ci', 'corepack-prepare-yarn-with-retry.sh');

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: 'utf8', mode: 0o700 });
}

test('Corepack Yarn preparation retries a failed download and preserves the pinned repository version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-corepack-retry-'));
  try {
    const binDir = path.join(root, 'bin');
    const logPath = path.join(root, 'corepack.log');
    const attemptPath = path.join(root, 'attempts');
    fs.mkdirSync(binDir);
    writeExecutable(path.join(binDir, 'corepack'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$1" = "enable" ]; then exit 0; fi',
      `attempt="$(cat ${JSON.stringify(attemptPath)} 2>/dev/null || printf 0)"`,
      'attempt="$((attempt + 1))"',
      `printf '%s' "$attempt" > ${JSON.stringify(attemptPath)}`,
      'if [ "$attempt" -lt 3 ]; then echo "Internal Error: Error when performing the request" >&2; exit 1; fi',
      'exit 0',
      '',
    ].join('\n'));
    writeExecutable(path.join(binDir, 'sleep'), ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'));

    execFileSync('bash', [script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_COREPACK_MAX_ATTEMPTS: '4',
        HAPPIER_COREPACK_RETRY_DELAY_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    assert.deepEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n'), [
      'enable',
      'prepare yarn@1.22.22 --activate',
      'prepare yarn@1.22.22 --activate',
      'prepare yarn@1.22.22 --activate',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Corepack Yarn preparation retries the Node TLS paused-stream assertion seen during downloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-corepack-paused-stream-'));
  try {
    const binDir = path.join(root, 'bin');
    const logPath = path.join(root, 'corepack.log');
    const attemptPath = path.join(root, 'attempts');
    fs.mkdirSync(binDir);
    writeExecutable(path.join(binDir, 'corepack'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$1" = "enable" ]; then exit 0; fi',
      `attempt="$(cat ${JSON.stringify(attemptPath)} 2>/dev/null || printf 0)"`,
      'attempt="$((attempt + 1))"',
      `printf '%s' "$attempt" > ${JSON.stringify(attemptPath)}`,
      'if [ "$attempt" -eq 1 ]; then',
      '  echo "AssertionError [ERR_ASSERTION]: assert(!this.paused)" >&2',
      '  echo "    at TLSSocket.emit (node:events:530:35)" >&2',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    writeExecutable(path.join(binDir, 'sleep'), ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'));

    execFileSync('bash', [script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_COREPACK_MAX_ATTEMPTS: '3',
        HAPPIER_COREPACK_RETRY_DELAY_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').filter((line) => line.startsWith('prepare ')).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Corepack Yarn preparation does not retry a permanent configuration failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-corepack-bounded-'));
  try {
    const binDir = path.join(root, 'bin');
    const logPath = path.join(root, 'corepack.log');
    fs.mkdirSync(binDir);
    writeExecutable(path.join(binDir, 'corepack'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$1" = "enable" ]; then exit 0; fi',
      'exit 1',
      '',
    ].join('\n'));
    writeExecutable(path.join(binDir, 'sleep'), ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'));

    assert.throws(() => execFileSync('bash', [script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_COREPACK_MAX_ATTEMPTS: '3',
        HAPPIER_COREPACK_RETRY_DELAY_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }));
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').filter((line) => line.startsWith('prepare ')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Corepack Yarn preparation remains bounded when transient downloads keep failing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-corepack-bounded-'));
  try {
    const binDir = path.join(root, 'bin');
    const logPath = path.join(root, 'corepack.log');
    fs.mkdirSync(binDir);
    writeExecutable(path.join(binDir, 'corepack'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$1" = "enable" ]; then exit 0; fi',
      'echo "Internal Error: Error when performing the request" >&2',
      'exit 1',
      '',
    ].join('\n'));
    writeExecutable(path.join(binDir, 'sleep'), ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'));

    assert.throws(() => execFileSync('bash', [script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_COREPACK_MAX_ATTEMPTS: '3',
        HAPPIER_COREPACK_RETRY_DELAY_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }));
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').filter((line) => line.startsWith('prepare ')).length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
