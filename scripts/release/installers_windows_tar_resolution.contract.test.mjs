import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 resolves Windows tar outside the current process PATH', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /function Resolve-TarExecutablePath\s*\{/i);
  assert.match(
    raw,
    /\[Environment\]::GetEnvironmentVariable\("Path",\s*\[EnvironmentVariableTarget\]::Machine\)/i,
    'expected tar resolution to include machine PATH entries such as System32',
  );
  assert.match(raw, /\$env:WINDIR[\s\S]*System32[\s\S]*tar\.exe/i);
  assert.match(raw, /\$tarPath\s*=\s*Resolve-TarExecutablePath/i);
  assert.match(raw, /&\s+\$tarPath\s+-xzf\s+\$archivePath\s+-C\s+\$extractDir/i);
  assert.doesNotMatch(
    raw,
    /(^|\n)\s*tar\s+-xzf\s+\$archivePath\s+-C\s+\$extractDir/i,
    'expected install.ps1 to avoid relying on the current process PATH for tar extraction',
  );
});
