import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 refreshes the current session PATH and prints Windows PATH reload guidance', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const guidanceMatch = raw.match(/function Show-PathReloadGuidance\s*\{[\s\S]*?\n\}/);

  assert.ok(guidanceMatch, 'expected install.ps1 to define Windows PATH reload guidance');
  assert.match(guidanceMatch[0], /The current PowerShell session can use \$ShimName immediately/i);
  assert.match(guidanceMatch[0], /Other already-open terminals keep their old PATH until you restart them/i);
  assert.match(guidanceMatch[0], /\$ShimName/);
  assert.match(raw, /\$machinePath\s*=\s*\[Environment\]::GetEnvironmentVariable\("Path",\s*\[EnvironmentVariableTarget\]::Machine\)/i);
  assert.match(raw, /\$processPathEntries\s*=\s*@\(\$updatedPathEntries\)\s*\+\s*@\(\$machinePathEntries\)/i);
  assert.match(raw, /\$updatedProcessPath\s*=\s*\(\$processPathEntries -join ';'\)/i);
  assert.match(raw, /\$env:Path\s*=\s*\$updatedProcessPath/i);
  assert.doesNotMatch(
    raw,
    /\$env:Path\s*=\s*\(\$updatedPathEntries -join ';'\)/i,
    'expected the refreshed process PATH to keep machine PATH entries such as System32',
  );
  assert.match(raw, /Show-PathReloadGuidance\s+-ShimName\s+\$displayShimBasename\s+-BinDir\s+\$displayShimDir\s+-ShimPath\s+\$displayShimPath/i);
  assert.ok(
    raw.lastIndexOf('Invoke-PostInstallAction -CliPath $invoker') < raw.lastIndexOf('Show-PathReloadGuidance -ShimName'),
    'expected the single PATH guidance block after any guided setup handoff',
  );
  assert.equal((raw.match(/Write-Host "Next steps"/g) ?? []).length, 0, 'PATH guidance must not add a competing next-steps heading');
  assert.match(raw, /Write-Host "\s+version:\s+\$version"/i, 'expected a labeled installed version in the install summary');
  assert.doesNotMatch(raw, /^\s*& \$invoker --version\s*$/mu, 'the raw --version result must not be rendered directly');
});

test('install.ps1 allows Windows installs without persistent PATH mutation', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(
    raw,
    /\$NoPathUpdate\s*=\s*if\s*\(\$env:HAPPIER_NO_PATH_UPDATE\)/i,
    'expected install.ps1 to read the cross-platform HAPPIER_NO_PATH_UPDATE opt-out',
  );
  assert.match(
    raw,
    /if\s*\(\$NoPathUpdate\s+-ne\s+"1"\)\s*\{[\s\S]*\[Environment\]::SetEnvironmentVariable\("Path"/i,
    'expected install.ps1 to guard persistent PATH writes behind HAPPIER_NO_PATH_UPDATE',
  );
});
