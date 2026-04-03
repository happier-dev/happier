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

test('expo submit supports --id for targeting a specific EAS build', () => {
  const src = readRepoFile('scripts/pipeline/expo/submit.mjs');

  assert.match(src, /\bid:\s*\{\s*type:\s*'string'/, 'expected submit.mjs to accept an id option');
  assert.match(src, /--id/, "expected submit.mjs to pass '--id' to eas submit when provided");
});
