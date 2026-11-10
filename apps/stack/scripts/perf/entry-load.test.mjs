// @happier-test-preparation source
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { renderNativeCommandPolicy, resolveRemoteCommandPolicy } from '../utils/dev_targets/remote_commands.mjs';
import { resolveRemoteValidationPreparationComponents } from '../utils/dev_targets/validation_preparation_policy.mjs';
import { ENTRY_GRAPHS } from './entry-load.mjs';

test('composed entry loads prepare every registered package graph before payload admission', async t => {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const args = ['node', 'apps/stack/scripts/perf/entry-load.mjs'];
  const policy = resolveRemoteCommandPolicy(args, { cwd: repo });
  assert.equal(policy.heavyClass, 'entry-loads');
  assert.equal(policy.kind, 'runtime');
  assert.deepEqual(new Set(resolveRemoteValidationPreparationComponents(policy.component, policy.kind, policy.preparationScope)),
    new Set(ENTRY_GRAPHS.map(graph => graph.preparationComponent ?? graph.cwd)));
  assert.equal(policy.localCompile, '1', 'SDK bundling retains the controller compilation guard');
  const fixture = await createTempFixture(t, { prefix: 'entry-load-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  if (process.platform !== 'win32') {
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s %s %s %s" "$policy_heavyClass" "$policy_kind" "$policy_localCompile" "$policy_preparationScope"',
      'policy', artifact, repo, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'entry-loads runtime 1 entry-loads');
  }
});
