import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readRepoFile(relPath) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('ui-mobile-release native_submit submits explicit build ids and does not wait for submission completion', () => {
  const src = readRepoFile('scripts/pipeline/run.mjs');

  // Cloud native_submit should submit by explicit build id (not --latest) and avoid blocking.
  assert.match(src, /explicitId[^]*\['--id', explicitId\]/, "expected native_submit to pass '--id <buildId>' to expo submit");
  assert.match(src, /'--wait'[^]*'false'/, "expected native_submit to pass '--wait false' to expo submit");

  // Local native_submit should also avoid blocking.
  assert.match(src, /'--path'[^]*'--wait'[^]*'false'/, "expected local native_submit to pass '--wait false' to expo submit");
});

