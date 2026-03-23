import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('apps/cli build script routes pkgroll through the manifest rewrite helper', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8'));
  const build = String(pkg?.scripts?.build ?? '');
  assert.ok(build, 'apps/cli/package.json scripts.build must exist');

  assert.match(build, /\bnode\s+scripts\/runPkgrollBuild\.mjs\b/, 'build should invoke the pkgroll manifest helper so pkgroll sees dist entrypoints during local/runtime builds');
});

test('apps/cli pkgroll helper resolves the local pkgroll cli directly instead of shelling out through npx', async () => {
  const helper = await import(pathToFileURL(path.join(repoRoot, 'apps', 'cli', 'scripts', 'runPkgrollBuild.mjs')).href);
  const pkgrollPath = helper.resolvePkgrollCliPath();

  assert.match(pkgrollPath, /node_modules[\\/]+pkgroll[\\/]+dist[\\/]+cli\.mjs$/, 'pkgroll helper should resolve the local pkgroll cli entrypoint directly');
});
