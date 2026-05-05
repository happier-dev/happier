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
    /function Invoke-InstallerDownloadWithRetry\s*\{[\s\S]*HAPPIER_INSTALLER_DOWNLOAD_RETRY_ATTEMPTS[\s\S]*HAPPIER_INSTALLER_DOWNLOAD_RETRY_DELAY_SECONDS[\s\S]*Invoke-WebRequest/i,
    'expected install.ps1 to define a bounded retry helper for transient release-asset downloads',
  );
  assert.match(
    source,
    /function Copy-OrDownloadInstallerAsset\s*\{[\s\S]*Invoke-InstallerDownloadWithRetry\s+-Uri\s+\$Source\s+-DestinationPath\s+\$DestinationPath/i,
    'expected release asset downloads to go through the retry helper',
  );
});
