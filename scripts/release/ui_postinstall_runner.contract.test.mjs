import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const uiPackagePath = join(repoRoot, 'apps', 'ui', 'package.json');

test('ui postinstall runner skips installed package context and respects npm_execpath', async () => {
  const uiPackageJson = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  const postinstallScript = String(uiPackageJson?.scripts?.postinstall ?? '');
  assert.ok(postinstallScript.length > 0, 'apps/ui package.json must define scripts.postinstall');
  assert.match(
    postinstallScript,
    /node_modules/i,
    'postinstall should no-op inside node_modules installs'
  );
  assert.match(
    postinstallScript,
    /npm_execpath/,
    'postinstall should prefer npm_execpath when available'
  );
  assert.match(
    postinstallScript,
    /process\.execPath/,
    'postinstall should execute npm_execpath via process.execPath'
  );
  assert.match(
    postinstallScript,
    /if\(r\.error\)/,
    'postinstall should surface spawn errors explicitly'
  );
  assert.match(
    postinstallScript,
    /postinstall:real/,
    'postinstall runner should continue to delegate to postinstall:real'
  );
});
