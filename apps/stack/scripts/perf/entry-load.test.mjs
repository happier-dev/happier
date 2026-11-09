import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { renderNativeCommandPolicy, resolveHeavyweightMemoryFloorKiB, resolveRemoteCommandPolicy } from '../utils/dev_targets/remote_commands.mjs';

test('composed entry loads use the measured validation envelope through both canonical dispatchers', async t => {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const args = ['node', 'apps/stack/scripts/perf/entry-load.mjs'];
  const policy = resolveRemoteCommandPolicy(args, { cwd: repo });
  assert.equal(policy.heavyClass, 'validation');
  // SYSTEMIC-DELETE owner Q1: successful 1,824,752 KiB tree peak, rounded up.
  assert.equal(resolveHeavyweightMemoryFloorKiB(policy.heavyClass), 2 * 1024 * 1024);
  assert.equal(policy.kind, 'source-test');
  assert.equal(policy.localCompile, '1', 'SDK bundling retains the controller compilation guard');
  const fixture = await createTempFixture(t, { prefix: 'entry-load-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  if (process.platform !== 'win32') {
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s %s %s" "$policy_heavyClass" "$policy_kind" "$policy_localCompile"',
      'policy', artifact, repo, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'validation source-test 1');
  }
});
