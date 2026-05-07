import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 makes the managed home bin directory the canonical PATH target on Windows', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(
    raw,
    /\$BinDir\s*=\s*Join-Path\s+\$InstallDir\s+"bin"/i,
    'expected install.ps1 to point PATH at the managed install bin directory',
  );
  assert.doesNotMatch(
    raw,
    /Copy-Item\s+-Path\s+\$target\s+-Destination\s+\(Join-Path\s+\$BinDir\s+"happier\.exe"\)\s+-Force/i,
    'expected install.ps1 to avoid maintaining a drifting external happier.exe copy',
  );
  assert.match(
    raw,
    /\$LegacyBinDir\s*=\s*Join-Path\s+\$env:USERPROFILE\s+"\.local\\bin"/i,
    'expected install.ps1 to keep track of the old default global shim directory for migration',
  );
  assert.match(
    raw,
    /Remove-Item\s+-Path\s+\(Join-Path\s+\$LegacyBinDir\s+"happier\.exe"\)/i,
    'expected install.ps1 to remove the old drifting global shim copy during migration',
  );
});

test('install.ps1 accepts an exact CLI version request through parameter or environment', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /\[string\]\s+\$Version\s*=\s*\$\(if\s*\(\$env:HAPPIER_INSTALL_VERSION\)/i);
  assert.match(raw, /Resolve-InstallerRequestedVersionPattern/i);
  assert.match(raw, /\$assetPattern\s*=\s*Resolve-InstallerRequestedVersionPattern[\s\S]*happier-v[\s\S]*windows-x64/i);
  assert.match(raw, /\$checksumsPattern\s*=\s*Resolve-InstallerRequestedVersionPattern[\s\S]*checksums-happier-v[\s\S]*\.txt/i);
  assert.doesNotMatch(raw, /\$asset\s*=\s*Resolve-InstallerAsset\s+-Release\s+\$release\s+-Pattern\s+'[\^]happier-v\.\*-windows-x64/i);
});

test('install.ps1 semver-sorts rolling release assets instead of relying on provider enumeration order', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /function Get-InstallerAssetVersionSortKey\s*\{/i);
  assert.match(raw, /function Select-NewestInstallerAsset\s*\{/i);
  assert.match(raw, /Get-AssetByPattern[\s\S]*Select-NewestInstallerAsset/i);
  assert.match(raw, /Get-LocalAssetByPattern[\s\S]*Select-NewestInstallerAsset/i);
  assert.doesNotMatch(raw, /Get-AssetByPattern[\s\S]*Select-Object\s+-Last\s+1/i);
  assert.doesNotMatch(raw, /Get-LocalAssetByPattern[\s\S]*Select-Object\s+-Last\s+1/i);
});

test('install.ps1 exposes installer-side rollback without invoking the current happier command', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /\[switch\]\s+\$Rollback/i);
  assert.match(raw, /HAPPIER_INSTALLER_ACTION/i);
  assert.match(raw, /function Invoke-InstallerCliRollback\s*\{/i);
  assert.match(raw, /previous\.version/i);
  assert.match(raw, /New-Item\s+-ItemType\s+HardLink[\s\S]*Resolve-CliShimName/i);
  const rollbackDispatchIndex = raw.indexOf('if ($InstallerAction -eq "rollback")');
  const installedCliFastPathIndex = raw.indexOf('if ($Run -and -not $SetupRelay -and ($existing = Resolve-InstalledCliInvoker))');
  assert.ok(rollbackDispatchIndex >= 0, 'expected install.ps1 to dispatch rollback directly');
  assert.ok(installedCliFastPathIndex >= 0, 'expected install.ps1 to keep the installed CLI fast path');
  assert.ok(
    rollbackDispatchIndex < installedCliFastPathIndex,
    'expected rollback to run before any installed CLI fast path can invoke the current happier command',
  );
});
