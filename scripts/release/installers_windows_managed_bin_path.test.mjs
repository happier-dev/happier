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
