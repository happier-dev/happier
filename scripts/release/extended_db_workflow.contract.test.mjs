import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

const repoRoot = new URL('../..', import.meta.url).pathname;

function loadWorkflow() {
  return YAML.parse(readFileSync(join(repoRoot, '.github', 'workflows', 'extended-db-tests.yml'), 'utf8'), {
    prettyErrors: true,
  });
}

test('extended DB E2E owns provider generation once and runs only database-relevant coverage', () => {
  const workflow = loadWorkflow();
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.on.workflow_call.inputs.checkout_sha, {
    required: false,
    default: '',
    type: 'string',
  });
  assert.equal(workflow.on.workflow_call.inputs.select_jobs_explicitly.type, 'boolean');
  assert.equal(workflow.on.workflow_call.inputs.select_jobs_explicitly.default, false);

  for (const [jobName, inputName] of [
    ['e2e-postgres', 'run_e2e_postgres'],
    ['e2e-mysql', 'run_e2e_mysql'],
    ['db-contract-postgres', 'run_db_contract_postgres'],
    ['db-contract-mysql', 'run_db_contract_mysql'],
  ]) {
    const checkout = workflow.jobs[jobName].steps.find((step) => step.name === 'Checkout');
    assert.equal(checkout.with.ref, '${{ inputs.checkout_sha || github.sha }}');
    assert.equal(
      workflow.jobs[jobName].if,
      `\${{ !inputs.select_jobs_explicitly || inputs.${inputName} }}`,
      `${jobName} must honor explicit false inputs while direct schedules retain the complete matrix`,
    );
  }

  for (const [jobName, provider] of [
    ['e2e-postgres', 'postgres'],
    ['e2e-mysql', 'mysql'],
  ]) {
    const job = workflow.jobs[jobName];
    const generate = job.steps.find((step) => step.name === `Generate server provider client (${provider})`);
    assert.ok(generate, `${jobName} should generate its provider client before Vitest starts`);
    assert.equal(generate.env.HAPPIER_BUILD_DB_PROVIDERS, provider);
    assert.equal(generate.run, 'yarn -s workspace @happier-dev/server generate:providers');

    const run = job.steps.find((step) => step.name === `Run core e2e database suite (${provider})`);
    assert.ok(run, `${jobName} should own a bounded external-database E2E command`);
    assert.equal(run.env.HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE, '1');
    assert.equal(
      run.run,
      'yarn test:e2e:core:fast -- --no-file-parallelism --maxWorkers=1 --minWorkers=1',
    );

    const upload = job.steps.find((step) => step.name === 'Upload e2e diagnostics (on failure)');
    assert.ok(upload, `${jobName} should retain bounded diagnostics`);
    assert.doesNotMatch(upload.with.path, /^\.project\/logs\/e2e$/m);
    assert.match(upload.with.path, /\.project\/logs\/e2e\/\*\*\/\*\.log/);
    assert.equal(upload.with['retention-days'], 7);
  }
});
