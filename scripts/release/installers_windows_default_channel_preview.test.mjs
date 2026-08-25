import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 defaults to stable channel when HAPPIER_CHANNEL is unset', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();
  assert.match(trimmed, /^(?:(?:#[^\r\n]*(?:\r?\n|$))|\s)*(?:\[CmdletBinding\([^\]]*\)\]\s*)?param\s*\(/i);
  assert.match(
    trimmed,
    /\[string\]\s+\$Channel\s*=\s*\$\(if\s*\(\$env:HAPPIER_CHANNEL\)\s*\{\s*\$env:HAPPIER_CHANNEL\s*\}\s*else\s*\{\s*"stable"\s*\}\)/i,
  );
});
