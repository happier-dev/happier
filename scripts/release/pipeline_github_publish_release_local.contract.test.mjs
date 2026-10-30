import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline GitHub release script can dry-run without GH_TOKEN/GH_REPO (uses local gh auth + repo context)', async (t) => {
  const binDir = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-release-local-git-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  // The executor mirror has no .git; exercise real origin inference via its OS boundary.
  fs.writeFileSync(resolve(binDir, 'git'), [
    '#!/bin/sh',
    'if [ "$*" = "remote get-url origin" ]; then',
    '  printf "%s\\n" "https://github.com/happier-dev/happier.git"',
    '  exit 0',
    'fi',
    'echo "unexpected Git invocation: $*" >&2; exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'github', 'publish-release.mjs'),
      '--tag',
      'cli-preview',
      '--title',
      'Happier CLI Preview',
      '--target-sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--prerelease',
      'true',
      '--rolling-tag',
      'true',
      '--generate-notes',
      'false',
      '--notes',
      'Rolling preview build.',
      '--prune-assets',
      'true',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '', PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[dry-run\] gh release view cli-preview/);
});

