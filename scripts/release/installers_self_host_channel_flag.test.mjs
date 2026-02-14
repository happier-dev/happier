import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('self-host.sh supports --channel preview/stable flags', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'self-host.sh');
  const raw = await readFile(path, 'utf8');
  assert.match(raw, /--channel\)/);
  assert.match(raw, /--preview\)/);
  assert.match(raw, /--stable\)/);
  assert.match(raw, /No stable releases found/i);
});
