import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverPackagePath = join(repoRoot, 'apps', 'server', 'package.json');

test('server postinstall runner skips installed package context and respects npm_execpath', async () => {
  const serverPackageJson = JSON.parse(await readFile(serverPackagePath, 'utf8'));
  const postinstallScript = String(serverPackageJson?.scripts?.postinstall ?? '');
  assert.ok(postinstallScript.length > 0, 'apps/server package.json must define scripts.postinstall');
  assert.match(
    postinstallScript,
    /node_modules/i,
    'server postinstall should no-op inside node_modules installs'
  );
  assert.match(
    postinstallScript,
    /npm_execpath/,
    'server postinstall should prefer npm_execpath when available'
  );
  assert.match(
    postinstallScript,
    /process\.execPath/,
    'server postinstall should execute npm_execpath via process.execPath'
  );
  assert.match(
    postinstallScript,
    /postinstall:real/,
    'server postinstall runner should delegate to postinstall:real'
  );
});
