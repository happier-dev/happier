import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('repo root package.json exposes repo-local hstack scripts', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const raw = await readFile(join(repoRoot, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  const scripts = pkg?.scripts ?? {};

  // Keep it minimal: assert the stable entrypoints exist and point to the wrapper.
  assert.equal(scripts.dev, 'node ./apps/stack/scripts/repo_local.mjs dev');
  assert.equal(scripts.start, 'node ./apps/stack/scripts/repo_local.mjs start');
  assert.equal(scripts.build, 'node ./apps/stack/scripts/repo_local.mjs build');
  assert.equal(scripts.tui, 'node ./apps/stack/scripts/repo_local.mjs tui');
});
