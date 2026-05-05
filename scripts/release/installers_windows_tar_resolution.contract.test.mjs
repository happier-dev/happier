import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 resolves tar.exe before extraction and reports actionable diagnostics', async () => {
  const source = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    source,
    /function Resolve-TarExecutable\s*\{[\s\S]*Get-Command\s+\$commandName[\s\S]*\[Environment\]::GetEnvironmentVariable\("Path",\s*\[EnvironmentVariableTarget\]::User\)[\s\S]*\[Environment\]::GetEnvironmentVariable\("Path",\s*\[EnvironmentVariableTarget\]::Machine\)[\s\S]*\$env:WINDIR[\s\S]*System32[\s\S]*tar\.exe/i,
    'expected install.ps1 to resolve tar.exe/tar from the current command table, User/Machine PATH, and System32 before extracting archives',
  );
  assert.match(
    source,
    /function Invoke-InstallerTarExtraction\s*\{[\s\S]*Resolve-TarExecutable[\s\S]*tar\.exe[\s\S]*-xzf/i,
    'expected install.ps1 to extract archives through a diagnostic tar wrapper',
  );
  assert.doesNotMatch(
    source,
    /^\s*tar\s+-xzf\s+\$archivePath\s+-C\s+\$extractDir\s*$/m,
    'expected install.ps1 not to call tar directly without diagnostics',
  );
});
