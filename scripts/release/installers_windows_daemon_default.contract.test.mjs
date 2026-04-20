import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 defaults background service installation to opt-in when noninteractive', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(trimmed, /\$env:HAPPIER_WITH_DAEMON/i);
  assert.match(trimmed, /else\s*\{\s*"0"\s*\}/i);
});

test('install.ps1 scopes background-service commands to the installer home when HAPPIER_HOME_DIR is unset', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(
    raw,
    /if\s*\(\s*-not\s+\$env:HAPPIER_HOME_DIR\s*\)\s*\{[\s\S]*?\$env:HAPPIER_HOME_DIR\s*=\s*\$InstallDir[\s\S]*?\}/i,
    'expected install.ps1 to default HAPPIER_HOME_DIR to the requested install root when unset so background-service commands do not target a different home',
  );
  assert.match(raw, /\$DaemonServiceStateHomeDir\s*=\s*\$env:HAPPIER_HOME_DIR/i);
});

test('install.ps1 calls Resolve-WithDaemonPreference with the renamed Entries parameter', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /function Resolve-WithDaemonPreference[\s\S]*?\[object\[\]\]\s+\$Entries\s*=\s*@\(\)/i);
  assert.doesNotMatch(raw, /function Resolve-WithDaemonPreference[\s\S]*?\[object\[\]\]\s+\$ExistingEntries\s*=\s*@\(\)/i);
  assert.match(raw, /Resolve-WithDaemonPreference\s+-Entries\s+\$backgroundServiceInventory\.Entries/i);
  assert.doesNotMatch(raw, /Resolve-WithDaemonPreference\s+-ExistingEntries\s+\$backgroundServiceInventory\.Entries/i);
});
