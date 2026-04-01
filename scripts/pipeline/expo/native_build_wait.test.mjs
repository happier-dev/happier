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

test('native-build supports disabling wait (so native_submit can schedule builds without blocking)', () => {
  const src = readRepoFile('scripts/pipeline/expo/native-build.mjs');
  assert.match(src, /\bwait:\s*\{\s*type:\s*'string'/, 'expected native-build.mjs to accept a wait flag');
  assert.match(src, /--no-wait/, "expected native-build.mjs to pass '--no-wait' when wait is disabled");
});

test('ui-mobile-release native_submit (cloud) disables waiting for EAS build completion', () => {
  const src = readRepoFile('scripts/pipeline/run.mjs');
  assert.match(src, /native_submit[\s\S]+--wait/, 'expected ui-mobile-release native_submit to pass --wait to native-build');
});

