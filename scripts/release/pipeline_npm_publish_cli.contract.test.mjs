import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can npm-publish in dry-run using env-only secrets', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-cli-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  fs.writeFileSync(path.join(tarballDir, 'happier-cli-v0.0.0-preview.tgz'), 'dummy', 'utf8');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'npm-publish',
      '--channel',
      'preview',
      '--tarball-dir',
      tarballDir,
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NPM_TOKEN: 'npm-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] npm publish: channel=preview/);
  assert.match(out, /\[dry-run\] npx -y npm@11\.5\.1 publish /);
  assert.match(out, /--tag next/);
});

