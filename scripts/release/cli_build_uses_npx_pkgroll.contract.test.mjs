import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('apps/cli build script invokes pkgroll via npx for workspace-hoisted bins', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8'));
  const build = String(pkg?.scripts?.build ?? '');
  assert.ok(build, 'apps/cli/package.json scripts.build must exist');

  assert.match(build, /\bnpx\s+pkgroll\b/, 'build should use npx pkgroll so it works when pkgroll is hoisted to repo root node_modules');
});

