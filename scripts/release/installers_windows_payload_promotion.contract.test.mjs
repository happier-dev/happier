import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 only falls back to direct binary copy for legacy payload installers', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(trimmed, /\$promotionResult\.ExitCode\s*-ne\s*0/i);
  assert.ok(
    trimmed.includes('Unknown self subcommand:\\s+__install-payload'),
    'expected payload promotion fallback to keep the legacy unknown-subcommand compatibility guard',
  );
  assert.ok(
    trimmed.includes('ENOENT: no such file or directory, open'),
    'expected payload promotion fallback to accept the released Windows payload-promotion ENOENT failure signature',
  );
  assert.match(trimmed, /Payload promotion failed\./i);
  assert.ok(
    trimmed.includes('$target = Join-Path $BinDir "$((Resolve-CliShimName)).exe"'),
    'expected legacy payload fallback to define the managed bin target explicitly',
  );
  assert.ok(
    trimmed.includes('Copy-Item -Path $binary -Destination $target -Force'),
    'expected legacy payload fallback to copy the extracted binary into the managed bin target',
  );
  assert.doesNotMatch(
    trimmed,
    /\$promotionResult\.ExitCode\s*-ne\s*0\s*\)\s*\{\s*Write-Warning\s+"Payload promotion failed, falling back to direct binary copy\."/i,
  );
});
