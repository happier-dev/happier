import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import YAML from 'yaml';

const repoRoot = new URL('../..', import.meta.url).pathname;

function loadWorkflow(name) {
  return YAML.parse(readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8'), { prettyErrors: true });
}

function needs(job) {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function resolveRunnerPool(step, runnerPool) {
  const scratch = mkdtempSync(join(tmpdir(), 'happier-runner-pool-'));
  const output = join(scratch, 'output');
  writeFileSync(output, '');
  try {
    const result = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_POOL: runnerPool },
    });
    return {
      ...result,
      outputs: Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('=', 2)),
      ),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function admitWorkflowRef(step, { eventName, eventRef, runnerPool, workflowRef }) {
  return spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CALLER_REPOSITORY: 'happier-dev/happier',
      WORKFLOW_REPOSITORY: 'happier-dev/happier',
      WORKFLOW_FILE: 'tests.yml',
      EVENT_NAME: eventName,
      EVENT_REF: eventRef,
      RUNNER_POOL: runnerPool,
      WORKFLOW_REF: workflowRef,
    },
  });
}

test('ordinary pull requests admit only exact GitHub merge refs through the canonical trust guard', () => {
  const tests = loadWorkflow('tests.yml');
  const guard = tests.jobs.trusted_ref_guard;
  const admission = guard.steps.find((step) => step.name === 'Admit trusted workflow control ref');
  assert.ok(admission, 'trusted_ref_guard must own PR workflow-ref admission');

  const mergeRef = 'refs/pull/123/merge';
  const mergeWorkflowRef = `happier-dev/happier/.github/workflows/tests.yml@${mergeRef}`;
  const admitted = admitWorkflowRef(admission, {
    eventName: 'pull_request',
    eventRef: mergeRef,
    runnerPool: 'github',
    workflowRef: mergeWorkflowRef,
  });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.deepEqual(tests.permissions, { contents: 'read' });
  assert.deepEqual(tests.jobs.ci_plan.permissions, { contents: 'read', 'pull-requests': 'read' });

  for (const rejected of [
    { eventName: 'workflow_dispatch', eventRef: mergeRef, runnerPool: 'github', workflowRef: mergeWorkflowRef },
    { eventName: 'pull_request', eventRef: mergeRef, runnerPool: 'blacksmith-linux-8vcpu', workflowRef: mergeWorkflowRef },
    {
      eventName: 'pull_request',
      eventRef: mergeRef,
      runnerPool: 'github',
      workflowRef: 'happier-dev/happier/.github/workflows/tests.yml@refs/heads/dev',
    },
    {
      eventName: 'pull_request',
      eventRef: 'refs/pull/123/head',
      runnerPool: 'github',
      workflowRef: 'happier-dev/happier/.github/workflows/tests.yml@refs/pull/123/head',
    },
    {
      eventName: 'pull_request',
      eventRef: 'refs/pull/not-a-number/merge',
      runnerPool: 'github',
      workflowRef: 'happier-dev/happier/.github/workflows/tests.yml@refs/pull/not-a-number/merge',
    },
    {
      eventName: 'pull_request',
      eventRef: mergeRef,
      runnerPool: 'github',
      workflowRef: 'happier-dev/happier/.github/workflows/tests.yml@refs/pull/124/merge',
    },
  ]) {
    const result = admitWorkflowRef(admission, rejected);
    assert.notEqual(result.status, 0, `must reject ${JSON.stringify(rejected)}`);
    assert.match(result.stderr, /Untrusted workflow control ref/);
  }

  const protectedWorkflowRef = 'happier-dev/happier/.github/workflows/tests.yml@refs/heads/dev';
  const protectedDispatch = admitWorkflowRef(admission, {
    eventName: 'workflow_dispatch',
    eventRef: 'refs/heads/dev',
    runnerPool: 'blacksmith-linux-8vcpu',
    workflowRef: protectedWorkflowRef,
  });
  assert.equal(protectedDispatch.status, 0, protectedDispatch.stderr);
});

test('manual test dispatch can opt approved non-secret Linux lanes into Blacksmith without changing ordinary CI', () => {
  const dispatch = loadWorkflow('tests-dispatch.yml');
  const tests = loadWorkflow('tests.yml');

  assert.deepEqual(dispatch.on.workflow_dispatch.inputs.runner_pool, {
    description: 'Runner pool — GitHub is the default; Blacksmith accelerates approved non-secret Linux test lanes',
    required: true,
    default: 'github',
    type: 'choice',
    options: ['github', 'blacksmith-linux-4vcpu', 'blacksmith-linux-8vcpu'],
  });
  assert.deepEqual(tests.on.workflow_call.inputs.runner_pool, {
    description: 'Runner pool for approved non-secret Linux test lanes',
    required: false,
    default: 'github',
    type: 'string',
  });
  assert.equal(dispatch.jobs.tests.with.runner_pool, '${{ inputs.runner_pool }}');

  const guard = tests.jobs.trusted_ref_guard;
  assert.equal(guard['runs-on'], 'ubuntu-latest');
  assert.deepEqual(guard.outputs, {
    ubuntu_2204: '${{ steps.runner_pool.outputs.ubuntu_2204 }}',
    ubuntu_2404: '${{ steps.runner_pool.outputs.ubuntu_2404 }}',
  });
  const resolver = guard.steps.find((step) => step.name === 'Resolve runner pool');
  assert.ok(resolver, 'trusted_ref_guard should own runner-pool validation and mapping');
  assert.equal(resolver.id, 'runner_pool');
  assert.equal(resolver.env.RUNNER_POOL, "${{ inputs.runner_pool || 'github' }}");

  const github = resolveRunnerPool(resolver, 'github');
  assert.equal(github.status, 0, github.stderr);
  assert.deepEqual(github.outputs, { ubuntu_2204: 'ubuntu-22.04', ubuntu_2404: 'ubuntu-latest' });

  const blacksmith = resolveRunnerPool(resolver, 'blacksmith-linux-4vcpu');
  assert.equal(blacksmith.status, 0, blacksmith.stderr);
  assert.deepEqual(blacksmith.outputs, {
    ubuntu_2204: 'blacksmith-4vcpu-ubuntu-2204',
    ubuntu_2404: 'blacksmith-4vcpu-ubuntu-2404',
  });

  const blacksmith8vcpu = resolveRunnerPool(resolver, 'blacksmith-linux-8vcpu');
  assert.equal(blacksmith8vcpu.status, 0, blacksmith8vcpu.stderr);
  assert.deepEqual(blacksmith8vcpu.outputs, {
    ubuntu_2204: 'blacksmith-8vcpu-ubuntu-2204',
    ubuntu_2404: 'blacksmith-8vcpu-ubuntu-2404',
  });

  const invalid = resolveRunnerPool(resolver, 'blacksmith-32vcpu-ubuntu-2404');
  assert.notEqual(invalid.status, 0, 'unsupported reusable-workflow input must fail instead of silently falling back');
  assert.match(invalid.stderr, /Unsupported runner_pool/);

  for (const jobName of [
    'ui-e2e',
    'ui-unit',
    'ui-integration',
    'shared-packages-unit',
    'server-db-contract',
    'cli',
    'e2e-core',
    'e2e-core-slow',
  ]) {
    assert.equal(tests.jobs[jobName]['runs-on'], '${{ needs.trusted_ref_guard.outputs.ubuntu_2204 }}');
    assert.ok(needs(tests.jobs[jobName]).includes('trusted_ref_guard'), `${jobName} must wait for runner admission`);
  }

  for (const jobName of ['server', 'stack', 'binary-smoke', 'typecheck']) {
    assert.equal(tests.jobs[jobName]['runs-on'], '${{ needs.trusted_ref_guard.outputs.ubuntu_2404 }}');
    assert.ok(needs(tests.jobs[jobName]).includes('trusted_ref_guard'), `${jobName} must wait for runner admission`);
  }

  assert.equal(tests.jobs.ui['runs-on'], 'ubuntu-22.04', 'the tiny UI result aggregator should not consume accelerated minutes');
  assert.equal(tests.jobs['release-contracts']['runs-on'], 'ubuntu-latest', 'release control contracts should remain on GitHub');
  assert.deepEqual(tests.jobs.cli.permissions, { contents: 'read' });
  assert.deepEqual(tests.jobs.stack.permissions, { contents: 'read' });
  for (const jobName of [
    'mobile-e2e-android',
    'installers-smoke-linux',
    'cli-daemon-e2e',
    'cli-update-continuity',
    'daemon-continuity',
    'session-continuity',
    'release-assets-docker',
    'self-host-systemd-e2e',
    'stress',
  ]) {
    assert.equal(tests.jobs[jobName]['runs-on'], 'ubuntu-latest', `${jobName} should remain on GitHub initially`);
  }
  assert.equal(tests.jobs.release_actor_guard['runs-on'], 'ubuntu-latest');
  assert.equal(tests.jobs.providers['runs-on'], 'ubuntu-latest');
  assert.equal(tests.jobs['installers-smoke-macos']['runs-on'], 'macos-latest');
  assert.equal(tests.jobs['installers-smoke-windows']['runs-on'], 'windows-latest');
  assert.deepEqual(tests.jobs['ui-e2e-wsrepl-lima']['runs-on'], ['self-hosted', 'macOS', 'wsrepl-lima']);
});
