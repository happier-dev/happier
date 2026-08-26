import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listBenchmarkWorkloads,
  resolveBenchmarkWorkload,
  resolveBenchmarkWorkloadInvocation,
} from './workload_catalog.mjs';

test('benchmark workload catalog owns reproducible metadata commands and measurement defaults', () => {
  const workloads = listBenchmarkWorkloads();
  assert.deepEqual(workloads.map((workload) => workload.id), [
    'metadata-find-source',
    'metadata-rg-files',
    'vcs-diff-stat',
    'vcs-grep-source',
    'vcs-status-short',
    'validation-cli-typecheck',
    'validation-cli-vitest-server-url',
    'validation-full-typecheck',
  ]);

  const rg = resolveBenchmarkWorkload('metadata-rg-files');
  assert.deepEqual(rg.command, { executable: 'rg', args: ['--threads', '1', '--files', 'apps', 'packages'] });
  assert.equal(rg.sourceRequirement, 'working-tree');
  assert.equal(rg.warmupCount, 1);
  assert.equal(rg.repeatCount, 5);

  const status = resolveBenchmarkWorkload('vcs-status-short');
  assert.equal(status.sourceRequirement, 'git-index');
  const cliTypecheck = resolveBenchmarkWorkload('validation-cli-typecheck');
  assert.equal(cliTypecheck.cwdRelative, 'apps/cli');
  assert.deepEqual(cliTypecheck.command, {
    executable: 'apps/stack/bin/hstack-exec',
    args: ['--local', '--script=typecheck:local'],
  });
  assert.deepEqual(resolveBenchmarkWorkloadInvocation('validation-cli-typecheck', { rootDir: '/repo' }), {
    command: '/repo/apps/stack/bin/hstack-exec',
    args: ['--local', '--script=typecheck:local'],
    cwd: '/repo/apps/cli',
    workload: cliTypecheck,
  });
  const vitest = resolveBenchmarkWorkload('validation-cli-vitest-server-url');
  assert.deepEqual(vitest.command.args, [
    '--local',
    '--script=vitest:local',
    '--',
    'run',
    'src/server/serverUrlClassification.test.ts',
  ]);
  assert.throws(() => resolveBenchmarkWorkload('missing'), /unknown benchmark workload/i);
});
