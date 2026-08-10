import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

function workflow(name) {
  return YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8'));
}

test('the Ubuntu slow gate prepares and runs the two exact server-v0.2.1 regression scenarios', () => {
  const testsWorkflow = workflow('tests.yml');
  const job = testsWorkflow.jobs['e2e-core-slow'];
  assert.equal(job['runs-on'], 'ubuntu-22.04');

  const prepareStep = job.steps.find((step) => step.name === 'Prepare immutable server-v0.2.1 artifact');
  assert.ok(prepareStep, 'slow gate must prepare the pinned immutable server artifact');
  assert.match(prepareStep.run, /HAPPIER_E2E_RELEASED_SERVER_V0_2_1_DIR/);
  assert.match(prepareStep.run, /prepare:compat:released-server-v0\.2\.1/);
  assert.match(prepareStep.run, /\$GITHUB_ENV/);

  const browserStep = job.steps.find((step) => step.name === 'Install exact-compatibility Playwright browser');
  assert.match(browserStep?.run ?? '', /playwright install --with-deps chromium/);

  const exactStep = job.steps.find((step) => step.name === 'Run exact server-v0.2.1 compatibility gate');
  assert.match(exactStep?.run ?? '', /test:compat:released-server-v0\.2\.1/);

  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'packages/tests/package.json'), 'utf8'));
  assert.match(
    packageJson.scripts['test:compat:released-server-v0.2.1'] ?? '',
    /pendingQueue\.releasedServerV021\.cli\.slow\.e2e\.test\.ts/,
  );
  assert.match(
    packageJson.scripts['test:compat:released-server-v0.2.1'] ?? '',
    /pendingQueue\.releasedServerV021\.firstPrompt\.spec\.ts/,
  );
});

test('the exact server-v0.2.1 gate accepts an optional immutable candidate checkout SHA without changing empty callers', () => {
  const testsWorkflow = workflow('tests.yml');
  const job = testsWorkflow.jobs['e2e-core-slow'];
  const input = testsWorkflow.on.workflow_call.inputs.checkout_sha;
  const guard = testsWorkflow.jobs.trusted_ref_guard;
  const validation = guard.steps.find((step) => step.name === 'Validate exact checkout SHA');
  const checkout = job.steps.find((step) => step.name === 'Checkout');
  const verification = job.steps.find((step) => step.name === 'Verify exact requested checkout SHA');

  assert.deepEqual(input, {
    required: false,
    default: '',
    type: 'string',
  });
  assert.deepEqual(job.needs, ['trusted_ref_guard']);
  assert.equal(validation?.if, "${{ inputs.checkout_sha != '' }}");
  assert.equal(validation?.env?.CHECKOUT_SHA, '${{ inputs.checkout_sha }}');
  assert.equal(checkout?.with?.ref, "${{ inputs.checkout_sha != '' && inputs.checkout_sha || github.sha }}");
  assert.equal(verification?.if, "${{ inputs.checkout_sha != '' }}");
  assert.equal(verification?.env?.CHECKOUT_SHA, '${{ inputs.checkout_sha }}');

  const valid = spawnSync('bash', ['-c', validation?.run ?? 'exit 1'], {
    encoding: 'utf8',
    env: { ...process.env, CHECKOUT_SHA: 'a'.repeat(40) },
  });
  assert.equal(valid.status, 0, valid.stderr);
  for (const value of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
    const invalid = spawnSync('bash', ['-c', validation?.run ?? 'exit 0'], {
      encoding: 'utf8',
      env: { ...process.env, CHECKOUT_SHA: value },
    });
    assert.notEqual(invalid.status, 0, `expected exact SHA validation to reject ${value}`);
  }
});

test('normal release orchestration does not present the two exact regressions as a general compatibility verdict', () => {
  const releaseWorkflow = workflow('release.yml');
  const candidateVerification = releaseWorkflow.jobs.verify_release_candidates;

  assert.ok(releaseWorkflow.jobs.ci.needs.includes('resolve_validation_profile'));
  assert.equal(releaseWorkflow.jobs.ci.with.run_e2e_core_slow, undefined);
  assert.equal(releaseWorkflow.jobs.supported_old_relay_compatibility, undefined);
  assert.ok(!candidateVerification.needs.includes('supported_old_relay_compatibility'));
});
