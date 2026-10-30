import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI docker-publish resolves HEAD SHA when --sha is omitted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-head-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = '0123456789abcdef0123456789abcdef01234567';
  fs.writeFileSync(path.join(root, 'git'), `#!/bin/sh\n[ "$*" = 'rev-parse HEAD' ] || exit 2\nprintf '%s\\n' '${sha}'\n`, { mode: 0o755 });
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'docker-publish',
      '--channel',
      'stable',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  );

  assert.match(out, /\[pipeline\] docker publish: channel=stable/);
  assert.match(out, /\[dry-run\] docker buildx build /);
  assert.ok(out.includes(`--tag happierdev/relay-server:stable-${sha.slice(0, 12)}`));
});
