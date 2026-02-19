import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('deploy workflow delegates webhook triggering to scripts/pipeline/deploy/trigger-webhooks.mjs', async () => {
  const workflowPath = join(repoRoot, '.github', 'workflows', 'deploy.yml');
  const raw = await readFile(workflowPath, 'utf8');

  assert.match(raw, /node scripts\/pipeline\/deploy\/trigger-webhooks\.mjs/);
  assert.doesNotMatch(
    raw,
    /curl\s+-sS\s+-X\s+POST/,
    'deploy.yml should not embed curl webhook logic once extracted to a script',
  );
});
