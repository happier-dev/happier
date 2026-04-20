import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow delegates binary smoke to the unified release-validation runner', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /binary-smoke:[\s\S]*?node scripts\/pipeline\/run\.mjs release-validate[\s\S]*?--suite binary-smoke[\s\S]*?--platform linux[\s\S]*?--source local-build[\s\S]*?--ref "\."/,
    'binary smoke workflow should call the unified release-validation runner with the local-build smoke suite',
  );
  assert.doesNotMatch(
    raw,
    /timeout\s+--signal=KILL\s+--kill-after=30s\s+\d+m\s+node\s+--test\s+apps\/stack\/scripts\//,
    'binary smoke workflow should not embed inline timeout/node orchestration once the executor owns it',
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
    /function didCommandTimeout\(result\)/,
    'binary smoke harness should normalize timeout detection across spawn timeout and GNU timeout exit codes',
  );
  assert.match(
    raw,
    /result\?\.status\s*===\s*124[\s\S]*result\?\.status\s*===\s*137/,
    'timeout normalization should treat GNU timeout exit codes as timeout outcomes',
  );
  assert.match(
    raw,
    /runWithHardTimeout\(\s*process\.execPath,\s*\[\s*'scripts\/pipeline\/release\/build-cli-binaries\.mjs'/,
    'CLI binary build path should use hard-timeout wrapper',
  );
  assert.match(
    raw,
    /runWithHardTimeout\(\s*process\.execPath,\s*\[\s*'scripts\/pipeline\/release\/build-server-binaries\.mjs'/,
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
