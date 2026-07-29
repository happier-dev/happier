import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 downloads release assets through a bounded retry helper', async () => {
  const source = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    source,
    /function Invoke-InstallerWebRequestWithRetry\s*\{[\s\S]*\$retryDelaysMs\s*=\s*@\([^)]*\)[\s\S]*Invoke-WebRequest[\s\S]*Test-InstallerTransientWebException/i,
    'expected install.ps1 to define a bounded retry helper for transient release-asset downloads',
  );
  assert.match(
    source,
    /function Copy-OrDownloadInstallerAsset\s*\{[\s\S]*Invoke-InstallerWebRequestWithRetry\s+-Uri\s+\$Source[\s\S]*-OutFile\s+\$DestinationPath/i,
    'expected release asset downloads to go through the retry helper',
  );
});

test('install.ps1 uses basic parsing for automated Windows PowerShell 5.1 downloads', async () => {
  const source = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');
  const helper = source.match(
    /function Invoke-InstallerWebRequestWithRetry\s*\{[\s\S]*?\n\}(?=\n\nfunction )/i,
  );

  assert.ok(helper, 'expected the canonical installer web-request helper');
  assert.match(
    helper[0],
    /\$params\s*=\s*@\{[^}]*\bUseBasicParsing\s*=\s*\$true[^}]*\}/i,
    'expected every installer-owned Invoke-WebRequest to opt into noninteractive basic parsing',
  );
  assert.equal(
    (source.match(/\bInvoke-WebRequest\b/gi) ?? []).length,
    (helper[0].match(/\bInvoke-WebRequest\b/gi) ?? []).length,
    'expected every direct Invoke-WebRequest call to remain inside the canonical retry helper',
  );
});
