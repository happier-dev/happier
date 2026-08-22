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

test('promote-server delegates deploy branch promotion to pipeline script', async () => {
  const raw = await loadWorkflow('promote-server.yml');
  assert.match(raw, /node scripts\/pipeline\/github\/promote-deploy-branch\.mjs/);
  assert.match(raw, /node scripts\/pipeline\/deploy\/trigger-webhooks\.mjs/);
  assert.doesNotMatch(raw, /Wait for deploy workflow/i);
});

test('server promotion admits the irreversible qualified V4 activation before deploy-branch mutation', async () => {
  const raw = await loadWorkflow('promote-server.yml');
  const admission = raw.indexOf('qualified-connected-accounts-v4-activation-admission.mjs');
  const promotion = raw.indexOf('node scripts/pipeline/github/promote-deploy-branch.mjs');

  assert.ok(admission >= 0, 'promote-server must run the qualified V4 activation admission check');
  assert.ok(promotion > admission, 'irreversible migration admission must precede deploy-branch mutation');
  assert.match(raw, /qualified_v4_activation_approval:/);
  assert.match(raw, /backup\/restore readiness/i);
  assert.match(raw, /old-server or old-daemon rollback/i);
  assert.match(raw, /old API and worker writers are stopped/i);
  assert.match(raw, /remain stopped if migration fails/i);
});
