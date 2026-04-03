import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeSignFile } from '../pipeline/release/lib/binary-release.mjs';

test('maybeSignFile feeds a newline to minisign when MINISIGN_PASSPHRASE is set to an empty string', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-minisign-empty-passphrase-'));

  const minisignOutPath = join(dir, 'minisign-stdin.txt');
  const minisignBinPath = join(dir, 'minisign');

  // Minimal fake minisign. It fails if stdin is closed/empty (no newline), and records the
  // first line read from stdin (empty is fine, as long as the read succeeds).
  await writeFile(
    minisignBinPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'out="${HAPPIER_TEST_MINISIGN_STDIN_OUT:?missing out path}"',
      'if ! IFS= read -r line; then',
      '  echo "stdin was not provided" >&2',
      '  exit 4',
      'fi',
      'printf "%s" "${line}" > "${out}"',
      'exit 0',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(minisignBinPath, 0o755);

  const payloadPath = join(dir, 'payload.txt');
  await writeFile(payloadPath, 'hello', 'utf-8');

  const envSnapshot = { ...process.env };
  try {
    process.env.HAPPIER_TEST_MINISIGN_STDIN_OUT = minisignOutPath;
    process.env.PATH = `${dir}:${envSnapshot.PATH ?? ''}`;
    process.env.MINISIGN_SECRET_KEY = 'untrusted comment: minisign secret key\nRWQ....\n';
    process.env.MINISIGN_PASSPHRASE = '';

    await maybeSignFile({ path: payloadPath });

    const stdinLine = await readFile(minisignOutPath, 'utf-8');
    assert.equal(stdinLine, '');
  } finally {
    process.env = envSnapshot;
  }
});

