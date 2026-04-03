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

test('pipeline run.mjs expo-submit forwards --id and --wait to submit.mjs', () => {
  const src = readRepoFile('scripts/pipeline/run.mjs');

  assert.match(src, /subcommand === 'expo-submit'/, 'expected expo-submit subcommand to exist');
  assert.match(src, /\bid:\s*\{\s*type:\s*'string'/, 'expected expo-submit to accept an id option');
  assert.match(src, /\bwait:\s*\{\s*type:\s*'string'/, 'expected expo-submit to accept a wait option');
  assert.match(src, /'--id'/, "expected expo-submit to pass '--id' through to submit.mjs");
  assert.match(src, /'--wait'/, "expected expo-submit to pass '--wait' through to submit.mjs");
});

