import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const workflows = ['issue-triage.yml', 'issue-triage-manual.yml'];

test('issue workflows transport sanitized context without dispatching an independent triage agent', async () => {
  for (const workflow of workflows) {
    const raw = await readFile(join(repoRoot, '.github', 'workflows', workflow), 'utf8');

    assert.match(raw, /issue context/);
    assert.doesNotMatch(raw, /issue triage (?:prepare|run|assign)/);
    assert.doesNotMatch(raw, /TRIAGE_BOT_ID|assign_agent|triage-prompt/);
  }
});

test('manual issue context retrieval has no issue-write permission', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'issue-triage-manual.yml'), 'utf8');

  assert.doesNotMatch(raw, /issues:\s*write/);
});
