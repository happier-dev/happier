import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('deploy workflow accepts push as caller event (via workflow_call)', async () => {
  const workflowPath = resolve(repoRoot, '.github', 'workflows', 'deploy.yml');
  const raw = fs.readFileSync(workflowPath, 'utf8');

  // Called workflows inherit `github.event_name` from the caller (e.g. push), so deploy.yml must not reject it.
  assert.match(raw, /Unsupported event for deploy workflow/, 'deploy.yml should keep a clear error message for unexpected events');
  assert.match(raw, /workflow_dispatch/, 'deploy.yml should still accept workflow_dispatch');
  assert.match(raw, /workflow_call/, 'deploy.yml should still accept workflow_call');
  assert.match(raw, /\bpush\b/, 'deploy.yml should accept push when invoked from a push-triggered caller workflow');
});

