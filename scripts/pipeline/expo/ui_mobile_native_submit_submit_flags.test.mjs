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

test('ui-mobile-release submits explicit build ids and retains asynchronous submissions outside production Android', () => {
  const src = readRepoFile('scripts/pipeline/run.mjs');

  // Cloud native_submit uses exact build ids; non-production Android submissions can remain asynchronous.
  assert.match(src, /explicitId[^]*\['--id', explicitId\]/, "expected native_submit to pass '--id <buildId>' to expo submit");
  assert.match(src, /'--wait'[^]*'false'/, "expected native_submit to pass '--wait false' to expo submit");

  // Local non-production Android submissions can remain asynchronous as well.
  assert.match(src, /'--path'[^]*'--wait'[^]*'false'/, "expected local native_submit to pass '--wait false' to expo submit");
});

