import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('installers keep daemon service strategy unset unless explicitly provided', async () => {
  const installSh = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const installPs1 = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.doesNotMatch(installSh, /HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY:-add/);
  assert.doesNotMatch(installPs1, /HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY\s*=\s*"add"/i);
});
