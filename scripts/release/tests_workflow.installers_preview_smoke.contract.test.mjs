import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow can smoke-test preview installers when requested', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(raw, /installers_channel:/, 'tests.yml should expose installers_channel input');
  assert.match(raw, /cli-preview/, 'tests.yml should be able to check cli-preview tag');
  assert.match(raw, /install-preview\.(sh|ps1)/, 'tests.yml should reference install-preview installers');
});

