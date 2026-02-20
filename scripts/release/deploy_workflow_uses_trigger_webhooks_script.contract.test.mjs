import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('deploy workflow delegates webhook triggering to the pipeline deploy command', async () => {
  const workflowPath = join(repoRoot, '.github', 'workflows', 'deploy.yml');
  const raw = await readFile(workflowPath, 'utf8');

  assert.match(raw, /node scripts\/pipeline\/run\.mjs deploy/);
  assert.doesNotMatch(
    raw,
    /curl\s+-sS\s+-X\s+POST/,
    'deploy.yml should not embed curl webhook logic once extracted to a script',
  );
});
