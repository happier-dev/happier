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
  assert.match(trimmed, /^param\s*\(/i);
  assert.match(trimmed, /ValidateSet\(\s*"stable"\s*,\s*"preview"\s*\)/i);
  assert.match(trimmed, /\$env:HAPPIER_CHANNEL/i);
  assert.match(trimmed, /else\s*\{\s*"stable"\s*\}/i);
});
