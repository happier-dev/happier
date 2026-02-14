import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('bootstrap-minisign script uses portable find grouping syntax', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'actions', 'bootstrap-minisign', 'bootstrap-minisign.sh'), 'utf8');
  assert.doesNotMatch(raw, /find [^\n]*\\\\\(/, 'bootstrap-minisign should not double-escape find grouping');
  assert.match(
    raw,
    /find [^\n]*\\\( -name minisign -o -name minisign\.exe \\\)/,
    'bootstrap-minisign should use single-escaped find grouping for minisign binary lookup',
  );
});
