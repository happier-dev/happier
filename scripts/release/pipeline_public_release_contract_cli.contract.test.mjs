import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPublicReleaseContractV1 } from '../pipeline/release/public-release-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pipelineCli = resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs');

test('release-contract emits only the versioned public release JSON contract', () => {
  const raw = execFileSync(process.execPath, [pipelineCli, 'release-contract'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.deepEqual(JSON.parse(raw), buildPublicReleaseContractV1());
});
