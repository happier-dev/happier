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
  assert.match(raw, /\$env:Path\s*=\s*\(\$updatedPathEntries -join ';'\)/i);
  assert.match(raw, /Show-PathReloadGuidance\s+-ShimName\s+\(Resolve-CliShimName\)\s+-BinDir\s+\$BinDir/i);
});
