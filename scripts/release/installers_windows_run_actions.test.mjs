import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 supports a whitelisted post-install -Run action', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(trimmed, /\[string\]\s*\$Run\b/i);
  assert.match(trimmed, /\$RunArgs\b/i);
  assert.match(trimmed, /ValueFromRemainingArguments\s*=\s*\$true/i);
  assert.match(trimmed, /\$SetupRelay\b/i);
  assert.match(trimmed, /HAPPIER_INSTALLER_RUN_ACTION/i);
  assert.match(trimmed, /HAPPIER_INSTALLER_SETUP_RELAY/i);
  assert.match(trimmed, /HAPPIER_DAEMON_SERVICE_CHANNEL/i);
  assert.match(trimmed, /HAPPIER_PUBLIC_RELEASE_CHANNEL/i);
  assert.match(trimmed, /HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY/i);
  assert.match(trimmed, /auth-login/i);
  assert.match(trimmed, /daemon-install/i);
  assert.match(trimmed, /providers-setup/i);

  // Ensure the script does not accept arbitrary execution.
  assert.doesNotMatch(trimmed, /Invoke-Expression\s+\$Run/i);
});
