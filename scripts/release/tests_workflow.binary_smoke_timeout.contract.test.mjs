import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow binds binary and artifact validation to an exact caller candidate checkout', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(
    raw,
    /checkout_sha:\n\s+required: false\n\s+default: ""\n\s+type: string/,
    'reusable tests must accept a candidate SHA from release verification',
  );
  assert.match(
    raw,
    /binary-smoke:[\s\S]*?ref: \$\{\{ inputs\.checkout_sha != '' && inputs\.checkout_sha \|\| github\.sha \}\}[\s\S]*?Verify exact requested checkout[\s\S]*?--suite binary-smoke[\s\S]*?--source git-ref-build[\s\S]*?--ref "\$CHECKOUT_SHA"/,
    'binary smoke must build and execute the exact candidate checkout, not treat the checkout directory as a packed manifest',
  );
  assert.match(
    raw,
    /artifact-verify:[\s\S]*?Verify exact requested checkout[\s\S]*?--suite artifact-verify[\s\S]*?--source local-build[\s\S]*?--ref dist\/release-assets\/cli/,
    'artifact verification must execute against artifacts built from the exact candidate checkout',
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
