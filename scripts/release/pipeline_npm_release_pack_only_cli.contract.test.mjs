import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI npm-release supports --mode pack (no publish) in dry-run', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'happier-npm-release-clean-control-'));
  try {
    await writeFile(join(temporaryRoot, 'git'), `#!/bin/sh
set -eu
if [ "$1" = rev-parse ] && [ "$2" = --is-inside-work-tree ]; then
  printf 'true\\n'
  exit 0
fi
if [ "$1" = status ] && [ "$2" = --porcelain=v1 ]; then
  exit 0
fi
printf 'unexpected git invocation: %s\\n' "$*" >&2
exit 2
`, { mode: 0o755 });
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'npm-release',
        '--channel',
        'preview',
        '--publish-cli',
        'true',
        '--publish-stack',
        'false',
        '--publish-server',
        'false',
        '--mode',
        'pack',
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${temporaryRoot}:${process.env.PATH ?? ''}`,
          NPM_TOKEN: 'npm-token',
          HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, /\[pipeline\] npm release: channel=preview/);
    assert.match(out, /apps\/cli/);
    assert.doesNotMatch(out, /publish-tarball\.mjs/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
