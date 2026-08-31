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

test('promote-server isolates deploy branch promotion and force webhook in trusted captured scripts', async () => {
  const raw = await loadWorkflow('promote-server.yml');
  assert.doesNotMatch(raw, /node scripts\/pipeline\/run\.mjs promote-deploy-branch/);
  assert.doesNotMatch(raw, /node scripts\/pipeline\/run\.mjs deploy/);
  assert.match(raw, /\$RUNNER_TEMP\/promote-server-deploy-ref\.mjs/);
  assert.match(raw, /\$RUNNER_TEMP\/deploy-ref-cas\.mjs/);
  assert.match(raw, /\$RUNNER_TEMP\/trigger-server-deploy-webhooks\.mjs/);
  assert.match(raw, /--expected-current-sha/);
  assert.match(raw, /group: deploy-ref-\$\{\{ github\.repository \}\}-\$\{\{ inputs\.environment \}\}-server/);
  assert.doesNotMatch(raw, /Wait for deploy workflow/i);
});
