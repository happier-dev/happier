import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function withCleanReleaseControlGit(run) {
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
    return await run(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test('pipeline CLI can npm-release in dry-run using env-only secrets', async () => {
  const out = await withCleanReleaseControlGit((gitDirectory) => execFileSync(
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
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${gitDirectory}:${process.env.PATH ?? ''}`,
        NPM_TOKEN: 'npm-token',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  ));

  assert.match(out, /\[pipeline\] npm release: channel=preview/);
  assert.match(out, /scripts\/pipeline\/npm\/release-packages\.mjs/);
  assert.match(out, /apps\/cli/);
});

test('npm-release local preview suffix does not default to preview.0.1 when GitHub run vars are unset', async () => {
  const out = await withCleanReleaseControlGit((gitDirectory) => execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'npm-release',
      '--channel',
      'preview',
      '--publish-cli',
      'true',
      '--publish-stack',
      'true',
      '--publish-server',
      'false',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${gitDirectory}:${process.env.PATH ?? ''}`,
        NPM_TOKEN: 'npm-token',
        GITHUB_RUN_NUMBER: '',
        GITHUB_RUN_ATTEMPT: '',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  ));

  assert.doesNotMatch(out, /-preview\.0\.1\b/, 'local preview suffix must be non-trivial to avoid npm publish collisions');
  assert.match(out, /-preview\.1\b/, 'local preview suffix should start at the first unpublished rolling version');
});
