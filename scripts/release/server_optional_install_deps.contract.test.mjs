import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverPackagePath = join(repoRoot, 'apps', 'server', 'package.json');

test('server keeps redis-memory-server optional so normal installs are not blocked by Redis binary prefetch', async () => {
  const serverPackageJson = JSON.parse(await readFile(serverPackagePath, 'utf8'));
  assert.equal(serverPackageJson?.devDependencies?.['redis-memory-server'], undefined);
  assert.equal(serverPackageJson?.optionalDependencies?.['redis-memory-server'], '^0.16.0');
});
