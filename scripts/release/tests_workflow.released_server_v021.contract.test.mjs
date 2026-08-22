import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

import { resolveReleaseValidationProfile } from '../pipeline/release-validation/registry.mjs';

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

test('normal release orchestration leaves the exact published-server regressions to diff-selected validation', () => {
  const releaseWorkflow = workflow('release.yml');
  assert.equal(releaseWorkflow.jobs.ci.with.run_e2e_core_slow, false);

  const stable = resolveReleaseValidationProfile('stable');
  assert.equal(stable?.checksProfile, 'full');

  const integrated = resolveReleaseValidationProfile('integrated');
  assert.equal(integrated?.checksProfile, 'fast');
});
