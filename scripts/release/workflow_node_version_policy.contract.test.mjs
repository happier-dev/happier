import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

test('workflows use Node 22 policy and do not pin Node 20', async () => {
  const files = (await readdir(workflowsDir)).filter((name) => name.endsWith('.yml'));

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    assert.doesNotMatch(raw, /node-version:\s*20\b/, `${file} must not use node-version: 20`);
    assert.doesNotMatch(raw, /NODE_VERSION:\s*"20"/, `${file} must not use NODE_VERSION=20`);
    assert.doesNotMatch(raw, /node-version:\s*\[[^\]]*\b20\b[^\]]*\]/, `${file} must not include Node 20 in a matrix`);
  }
});

test('release workflows pin Yarn via Corepack (avoid runner drift)', async () => {
  const expected = /corepack prepare yarn@1\.22\.22 --activate/;
  const files = [
    'release.yml',
    'release-npm.yml',
    'promote-ui.yml',
    'promote-server.yml',
    'promote-website.yml',
    'promote-docs.yml',
    'build-tauri.yml',
  ];

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    assert.match(raw, expected, `${file} should pin Yarn via corepack prepare yarn@1.22.22`);
  }
});
