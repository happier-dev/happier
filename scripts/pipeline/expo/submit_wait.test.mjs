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

test('expo submit supports disabling wait (so native_submit does not block on long EAS queues)', () => {
  const src = readRepoFile('scripts/pipeline/expo/submit.mjs');
  assert.match(src, /\bwait:\s*\{\s*type:\s*'string'/, 'expected submit.mjs to accept a wait flag');
  assert.match(src, /function\s+parseBool\s*\(/, 'expected submit.mjs to define parseBool helper');
  assert.match(src, /--no-wait/, "expected submit.mjs to pass '--no-wait' when wait is disabled");
});
