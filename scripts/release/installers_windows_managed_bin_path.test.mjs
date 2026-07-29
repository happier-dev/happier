import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function extractPowerShellBlock(source, startNeedle) {
  const startIndex = source.indexOf(startNeedle);
  assert.ok(startIndex >= 0, `expected PowerShell block: ${startNeedle}`);

  const openingBraceIndex = source.indexOf('{', startIndex + startNeedle.length);
  assert.ok(openingBraceIndex >= 0, `expected opening brace for: ${startNeedle}`);

  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  assert.fail(`expected closing brace for: ${startNeedle}`);
}

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

test('install.ps1 skips every installer-owned PATH write when HAPPIER_NO_PATH_UPDATE=1', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(
    raw,
    /\$NoPathUpdate\s*=\s*if\s*\(\$env:HAPPIER_NO_PATH_UPDATE\)\s*\{\s*\$env:HAPPIER_NO_PATH_UPDATE\s*\}\s*else\s*\{\s*"0"\s*\}/i,
    'expected an absent HAPPIER_NO_PATH_UPDATE value to preserve ordinary PATH installation',
  );

  const guardedPathUpdate = extractPowerShellBlock(raw, 'if ($NoPathUpdate -ne "1")');
  const persistentUserPathWrite =
    /\[Environment\]::SetEnvironmentVariable\(\s*"Path"\s*,[\s\S]*?\[EnvironmentVariableTarget\]::User\s*\)/gi;
  const processPathWrite = /\$env:Path\s*=/gi;
  const guardedPersistentWrites = guardedPathUpdate.match(persistentUserPathWrite) ?? [];
  const allPersistentWrites = raw.match(persistentUserPathWrite) ?? [];
  const guardedProcessWrites = guardedPathUpdate.match(processPathWrite) ?? [];
  const allProcessWrites = raw.match(processPathWrite) ?? [];

  assert.equal(
    allPersistentWrites.length,
    1,
    'expected one canonical persistent user PATH writer in install.ps1',
  );
  assert.equal(
    guardedPersistentWrites.length,
    allPersistentWrites.length,
    'expected HAPPIER_NO_PATH_UPDATE=1 to guard every persistent user PATH writer',
  );
  assert.equal(
    allProcessWrites.length,
    1,
    'expected one canonical installer-process PATH writer in install.ps1',
  );
  assert.equal(
    guardedProcessWrites.length,
    allProcessWrites.length,
    'expected HAPPIER_NO_PATH_UPDATE=1 to guard every installer-process PATH writer',
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

test('install.ps1 semver-sorts rolling assets and keeps default asset patterns channel-safe', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(
    raw,
    /function Get-ReleaseAssetVersionFromName\s*\{[\s\S]*checksums-.+-v[\s\S]*windows-x64\.tar\.gz/i,
    'expected install.ps1 to extract release versions from rolling asset names before ranking them',
  );
  assert.match(
    raw,
    /function Get-ReleaseAssetVersionSortKey\s*\{[\s\S]*stable[\s\S]*preview[\s\S]*dev/i,
    'expected install.ps1 to build a semantic sort key that preserves stable/preview/dev prerelease ordering',
  );
  assert.match(
    raw,
    /function Resolve-InstallerDefaultVersionPattern\s*\{[\s\S]*preview[\s\S]*-preview[\s\S]*publicdev[\s\S]*-dev/i,
    'expected install.ps1 to derive the default rolling version pattern from the selected channel',
  );
  assert.match(
    raw,
    /function Resolve-InstallerRequestedVersionPattern\s*\{[\s\S]*Resolve-InstallerDefaultVersionPattern/i,
    'expected install.ps1 to use a channel-safe default asset version pattern when no explicit version is requested',
  );
  assert.doesNotMatch(
    raw,
    /return\s+"\^\$\(\[Regex\]::Escape\(\$Prefix\)\)\.\*\$\(\[Regex\]::Escape\(\$Suffix\)\)\$"/i,
    'expected install.ps1 not to use a catch-all rolling asset wildcard that can cross channel boundaries',
  );
  assert.match(
    raw,
    /function Get-AssetByPattern\s*\{[\s\S]*Get-ReleaseAssetVersionSortKey/i,
    'expected remote release asset lookup to rank matches by semantic version instead of provider order',
  );
  assert.match(
    raw,
    /function Get-LocalAssetByPattern\s*\{[\s\S]*Get-ReleaseAssetVersionSortKey/i,
    'expected local release asset lookup to rank matches by semantic version instead of filesystem order',
  );
  assert.doesNotMatch(
    raw,
    /function Get-AssetByPattern\s*\{[\s\S]*Select-Object\s+-Last\s+1/i,
    'expected remote release asset lookup to avoid trusting GitHub asset order',
  );
  assert.doesNotMatch(
    raw,
    /function Get-LocalAssetByPattern\s*\{[\s\S]*Select-Object\s+-Last\s+1/i,
    'expected local release asset lookup to avoid trusting filesystem enumeration order',
  );
});

test('install.ps1 exposes installer-side rollback without invoking the current happier command', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /\[switch\]\s+\$Rollback/i);
  assert.match(raw, /HAPPIER_INSTALLER_ACTION/i);
  assert.match(raw, /function Invoke-InstallerCliRollback\s*\{/i);
  assert.match(raw, /previous\.version/i);
  assert.match(raw, /New-Item\s+-ItemType\s+HardLink[\s\S]*Resolve-CliShimName/i);
  assert.match(raw, /function Enter-InstallerPayloadMutationLock\s*\{/i);
  assert.match(raw, /\.mutation\.lock/i);
  assert.match(raw, /function Write-InstallerMarkerFileAtomic\s*\{/i);
  assert.match(raw, /function Restore-InstallerCliRollbackPublications\s*\{/i);
  assert.match(raw, /FIRST_PARTY_VERSION_ID_INVALID|invalid version id/i);
  assert.match(
    raw,
    /Invoke-InstallerCliRollback[\s\S]*Enter-InstallerPayloadMutationLock[\s\S]*try\s*\{[\s\S]*Restore-InstallerCliRollbackPublications[\s\S]*finally\s*\{[\s\S]*Exit-InstallerPayloadMutationLock/i,
  );
  const rollbackBodyStart = raw.indexOf('function Invoke-InstallerCliRollback');
  const rollbackBodyEnd = raw.indexOf('function Resolve-TarExecutablePath', rollbackBodyStart);
  const rollbackBody = raw.slice(rollbackBodyStart, rollbackBodyEnd);
  const legacyBackupDecision = rollbackBody.indexOf('$legacyCurrentBackupPath = ""');
  const publicationTry = rollbackBody.indexOf('try {', legacyBackupDecision);
  const publicationCatch = rollbackBody.indexOf('catch {', publicationTry);
  const shimPublication = rollbackBody.indexOf('Sync-InstallerCliRollbackShim', publicationTry);
  const legacyBackupCleanup = rollbackBody.indexOf('Remove-Item -Path $legacyCurrentBackupPath', publicationTry);
  assert.ok(publicationTry >= 0 && publicationCatch >= 0, 'expected a rollback publication transaction');
  assert.ok(
    shimPublication > publicationTry && shimPublication < publicationCatch,
    'expected shim publication failure to restore the prior pointer/marker transaction',
  );
  assert.ok(
    legacyBackupCleanup > shimPublication && legacyBackupCleanup < publicationCatch,
    'expected legacy current backup cleanup only after shim publication succeeds',
  );
  const rollbackDispatchIndex = raw.indexOf('if ($InstallerAction -eq "rollback")');
  const installedCliFastPathIndex = raw.indexOf('if ($Run -and -not $SetupRelay -and ($existing = Resolve-InstalledCliInvoker))');
  assert.ok(rollbackDispatchIndex >= 0, 'expected install.ps1 to dispatch rollback directly');
  assert.ok(installedCliFastPathIndex >= 0, 'expected install.ps1 to keep the installed CLI fast path');
  assert.ok(
    rollbackDispatchIndex < installedCliFastPathIndex,
    'expected rollback to run before any installed CLI fast path can invoke the current happier command',
  );
});
