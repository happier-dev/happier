import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 performs deterministic Windows lock hygiene before payload promotion', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /Invoke-InstallerPreInstallLockHygiene[\s\S]*\$promotionResult\s*=\s*Invoke-InstallerPayloadPromotionWithTimeout/i,
    'expected lock hygiene to run before payload promotion',
  );
  assert.ok(
    trimmed.includes('@("service", "stop", "--json")'),
    'expected lock hygiene to stop managed background services before payload promotion',
  );
  assert.ok(
    trimmed.includes('@("daemon", "stop", "--all", "--kill-sessions", "--json")'),
    'expected lock hygiene to stop managed daemon-owned sessions before payload promotion',
  );
  assert.match(
    trimmed,
    /\$happierProcessNames\s*=\s*@\(\s*"happier",\s*"hprev",\s*"hdev"\s*\)/i,
    'expected lock hygiene to target known Happier process names only',
  );
  assert.match(
    trimmed,
    /Stop-Process\s+-Id\s+\$process\.ProcessId\s+-Force\s+-ErrorAction\s+SilentlyContinue/i,
    'expected lock hygiene to force-stop scoped holder processes',
  );
  assert.match(
    trimmed,
    /Wait-InstallerLockHygieneProcessesToExit/i,
    'expected lock hygiene to wait for holders to exit before promotion proceeds',
  );
});

test('install.ps1 cleans stale version backup directories before payload promotion', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(
    trimmed,
    /Remove-StaleInstallerVersionBackups/i,
    'expected lock hygiene to include stale backup cleanup',
  );
  assert.match(
    trimmed,
    /Get-ChildItem\s+-Path\s+\$versionsDir\s+-Directory[\s\S]*\.bak-/i,
    'expected stale backup cleanup to target versioned .bak-* directories',
  );
});
