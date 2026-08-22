import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('promote-server delegates server runtime publishing to the trusted reusable workflow', async () => {
  const raw = await loadWorkflow('promote-server.yml');

  assert.match(
    raw,
    /publish_runtime_release:[\s\S]*?uses:\s*\.\/\.github\/workflows\/publish-server-runtime\.yml[\s\S]*?authorized_sha:/,
    'promote-server should keep runtime publishing delegated to the trusted reusable workflow',
  );
  assert.doesNotMatch(raw, /gh release upload/, 'promote-server should not embed gh release upload');
  assert.doesNotMatch(raw, /gh release create/, 'promote-server should not embed gh release create');
});

test('promote-server does not inline signing setup in the promotion workflow', async () => {
  const raw = await loadWorkflow('promote-server.yml');

  assert.doesNotMatch(
    raw,
    /bootstrap-minisign|apt-get install -y minisign/,
    'promote-server should leave signing setup to publish-server-runtime.yml',
  );
});
