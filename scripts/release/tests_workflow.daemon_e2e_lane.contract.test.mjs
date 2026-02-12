import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow runs daemon integration suite on the integration lane', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /yarn\s+--cwd\s+apps\/cli\s+-s\s+vitest\s+run\s+--config\s+vitest\.integration\.config\.ts\s+src\/daemon\/daemon\.integration\.test\.ts/,
    'tests.yml daemon e2e step should execute daemon.integration.test.ts with vitest.integration.config.ts',
  );
});
