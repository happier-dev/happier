import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow bounds binary smoke subtests with hard process time limits', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /timeout\s+--signal=KILL\s+--kill-after=30s\s+25m\s+node\s+--test\s+apps\/stack\/scripts\/self_host_binary_smoke\.integration\.test\.mjs/,
    'binary smoke workflow should hard-timeout self_host_binary_smoke integration execution',
  );
  assert.match(
    raw,
    /timeout\s+--signal=KILL\s+--kill-after=30s\s+45m\s+node\s+--test\s+apps\/stack\/scripts\/release_binary_smoke\.integration\.test\.mjs/,
    'binary smoke workflow should allow enough time for release_binary_smoke before hard-timeout',
  );
});

test('release binary smoke test enforces hard sub-process timeouts for build phases', async () => {
  const raw = await readFile(join(repoRoot, 'apps', 'stack', 'scripts', 'release_binary_smoke.integration.test.mjs'), 'utf8');

  assert.match(
    raw,
    /spawnSync\('timeout',\s*\[\s*'--signal=KILL',\s*'--kill-after=30s'/,
    'release binary smoke should use coreutils timeout to hard-kill build subprocess trees',
  );
  assert.match(
    raw,
    /build-cli-binaries\.mjs[\s\S]*timeoutMs:\s*15\s*\*\s*60\s*\*\s*1000/,
    'release binary smoke should bound CLI binary build subprocess runtime',
  );
  assert.match(
    raw,
    /build-server-binaries\.mjs[\s\S]*timeoutMs:\s*15\s*\*\s*60\s*\*\s*1000/,
    'release binary smoke should bound server binary build subprocess runtime',
  );
});
