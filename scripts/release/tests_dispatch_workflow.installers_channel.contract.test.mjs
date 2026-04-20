import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('manual tests dispatch exposes all supported installer smoke channels', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests-dispatch.yml'), 'utf8');

  assert.match(raw, /installers_channel:/, 'tests-dispatch.yml should expose an installers_channel input');
  assert.match(raw, /description:\s*"Installers — Channel for installer smoke tests"/, 'tests-dispatch.yml should document the installer smoke channel input');
  assert.match(raw, /default:\s*stable/, 'tests-dispatch.yml should keep stable as the default manual installer lane');
  assert.match(raw, /options:\s*\n(?:\s*-\s*[^\n]+\n)+/m, 'tests-dispatch.yml should enumerate manual installer channel choices');
  assert.match(raw, /-\s*stable/, 'tests-dispatch.yml should allow stable installer smoke');
  assert.match(raw, /-\s*preview/, 'tests-dispatch.yml should allow preview installer smoke');
  assert.match(raw, /-\s*dev/, 'tests-dispatch.yml should allow dev installer smoke');
});
