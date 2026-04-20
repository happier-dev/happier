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

test('promote-server delegates server runtime publishing to the shared pipeline command', async () => {
  const raw = await loadWorkflow('promote-server.yml');

  assert.match(
    raw,
    /node scripts\/pipeline\/run\.mjs publish-server-runtime[\s\S]*?--channel "\$\{CHANNEL\}"[\s\S]*?--allow-stable "\$\{ALLOW_STABLE\}"[\s\S]*?--run-contracts false[\s\S]*?--check-installers false/,
    'promote-server should keep runtime publishing delegated to publish-server-runtime',
  );
  assert.doesNotMatch(raw, /gh release upload/, 'promote-server should not embed gh release upload');
  assert.doesNotMatch(raw, /gh release create/, 'promote-server should not embed gh release create');
});

test('promote-server bootstraps minisign through the shared pinned action', async () => {
  const raw = await loadWorkflow('promote-server.yml');

  assert.match(
    raw,
    /- name: Install minisign \(signing \+ verification\)[\s\S]*?uses:\s*\.\/\.github\/actions\/bootstrap-minisign/,
    'promote-server should use the shared bootstrap-minisign action for signing tool setup',
  );
  assert.doesNotMatch(
    raw,
    /- name: Install minisign \(signing \+ verification\)[\s\S]*?apt-get install -y minisign/,
    'promote-server should not rely on apt minisign installation',
  );
});
