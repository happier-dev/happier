import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow gates installer smoke on existing release tags (bootstrap-friendly)', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  // We deliberately avoid hard-coding step names; we only assert on the behavior:
  // the workflow must check for the cli-stable tag and only run the installer when it exists.
  assert.match(raw, /releases\/tags\/cli-stable/, 'tests.yml should check GitHub releases/tags/cli-stable');

  const expectedIf = /if:\s*steps\.cli_tag\.outputs\.tag_exists\s*==\s*'true'/;
  assert.match(raw, expectedIf, 'installer smoke steps should be gated by cli_tag.tag_exists');
});
