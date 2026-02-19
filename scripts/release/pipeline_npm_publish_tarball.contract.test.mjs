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

test('pipeline npm publish script supports dry-run and derives dist-tag from channel', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  const tarballPath = path.join(tarballDir, 'happier-cli-v0.0.0-preview.tgz');
  fs.writeFileSync(tarballPath, 'dummy', 'utf8');

  const outLocal = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball-dir',
      tarballDir,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outLocal, /\[dry-run\] npx -y npm@11\.5\.1 publish /);
  assert.doesNotMatch(outLocal, /--provenance/, 'local default should not force npm provenance');
  assert.match(outLocal, /--access public/);
  assert.match(outLocal, /--tag next/);

  const outGithub = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outGithub, /\[dry-run\] npx -y npm@11\.5\.1 publish /);
  assert.match(outGithub, /--provenance/, 'GitHub Actions default should enable npm provenance');
});

test('pipeline npm publish uses isolated npmrc when NPM_TOKEN is provided', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-token-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  const tarballPath = path.join(tarballDir, 'happier-cli-v0.0.0-preview.tgz');
  fs.writeFileSync(tarballPath, 'dummy', 'utf8');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NPM_TOKEN: 'npm-token-for-test' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] npm auth: using isolated npmrc/);
  assert.doesNotMatch(out, /npm-token-for-test/, 'script output must never include the npm token');
});
