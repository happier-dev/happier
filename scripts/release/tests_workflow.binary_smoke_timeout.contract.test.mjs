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

test('release binary smoke harness hard-kills nested build commands on timeout', async () => {
  const raw = await readFile(join(repoRoot, 'apps', 'stack', 'scripts', 'release_binary_smoke.integration.test.mjs'), 'utf8');

  assert.match(raw, /function runWithHardTimeout\(/, 'binary smoke harness should define a hard-timeout spawn helper');
  assert.match(
    raw,
    /spawnSync\('timeout',\s*\['--signal=KILL',\s*'--kill-after=30s'/,
    'binary smoke harness should use GNU timeout with SIGKILL fallback',
  );
  assert.match(
    raw,
    /runWithHardTimeout\(\s*process\.execPath,\s*\[\s*'scripts\/release\/build-cli-binaries\.mjs'/,
    'CLI binary build path should use hard-timeout wrapper',
  );
  assert.match(
    raw,
    /runWithHardTimeout\(\s*process\.execPath,\s*\[\s*'scripts\/release\/build-server-binaries\.mjs'/,
    'server binary build path should use hard-timeout wrapper',
  );
  assert.match(
    raw,
    /runWithHardTimeout\(\s*cliExtract\.binaryPath,\s*\[\s*'--version'\s*\]/,
    'CLI binary invocation should use hard-timeout wrapper',
  );
  assert.match(
    raw,
    /runWithHardTimeout\(\s*serverExtract\.binaryPath,\s*\[\s*\]/,
    'server binary invocation should use hard-timeout wrapper',
  );
});
