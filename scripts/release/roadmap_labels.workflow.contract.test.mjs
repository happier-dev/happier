import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('roadmap label bootstrap owns the channel-stage vocabulary and migrates its predecessors', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'roadmap-bootstrap-labels.yml'), 'utf8');

  for (const stage of ['source', 'dev', 'preview', 'stable']) {
    assert.match(raw, new RegExp(`name: 'stage:${stage}'`));
  }
  for (const legacy of ['not-shipped', 'experimental', 'beta', 'ga']) {
    assert.match(raw, new RegExp(`from: 'stage:${legacy}'`));
  }
  assert.match(raw, /issues\.updateLabel\([\s\S]*?name: migration\.from[\s\S]*?new_name: migration\.to/);
  assert.doesNotMatch(raw, /name: 'stage:not-shipped', color/);
});
