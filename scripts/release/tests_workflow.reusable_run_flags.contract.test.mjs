import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function runInlineCollector(env) {
  const testsRaw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const collectorSource = testsRaw.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/)?.[1];
  assert.ok(collectorSource, 'expected the inline CI lane collector');

  const scratch = mkdtempSync(join(tmpdir(), 'happier-ci-collector-'));
  try {
    return spawnSync(process.execPath, ['--input-type=module'], {
      input: collectorSource,
      encoding: 'utf8',
      cwd: scratch,
      env: {
        ...process.env,
        CI_RUN_ID: '123',
        CI_SOURCE_SHA: 'a'.repeat(40),
        CI_WORKFLOW: 'CI — Tests',
        ...env,
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('reusable tests calls make their run flags authoritative regardless of the caller event', async () => {
  const testsRaw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const testsWorkflow = YAML.parse(testsRaw, { prettyErrors: true });

  assert.equal(testsWorkflow.on.workflow_call.inputs.select_jobs_explicitly.type, 'boolean');
  assert.equal(testsWorkflow.on.workflow_call.inputs.select_jobs_explicitly.default, false);
  assert.equal(
    testsWorkflow.concurrency.group,
    'tests-${{ github.workflow }}-${{ github.ref }}',
    'the reusable tests workflow must not share its caller concurrency group and cancel the caller',
  );
  assert.equal(
    testsWorkflow.concurrency['cancel-in-progress'],
    false,
    'an active full collector must finish; GitHub may replace the single pending run, but a later push must not discard in-flight evidence',
  );

  const defaultSuiteInputs = new Map([
    ['ui-e2e', 'run_ui_e2e'],
    ['ui-unit', 'run_ui'],
    ['ui-integration', 'run_ui'],
    ['shared-packages-unit', 'run_ui'],
    ['server', 'run_server'],
    ['server-db-contract', 'run_server_db_contract'],
    ['cli', 'run_cli'],
    ['stack', 'run_stack'],
    ['release-contracts', 'run_release_contracts'],
    ['installers-smoke-macos', 'run_installers_smoke'],
    ['installers-smoke-linux', 'run_installers_smoke'],
    ['installers-smoke-windows', 'run_installers_smoke'],
    ['binary-smoke', 'run_binary_smoke'],
    ['typecheck', 'run_typecheck'],
    ['cli-daemon-e2e', 'run_cli_daemon_e2e'],
    ['e2e-core', 'run_e2e_core'],
  ]);

  for (const [jobName, inputName] of defaultSuiteInputs) {
    assert.equal(
      testsWorkflow.jobs[jobName].if,
      `\${{ (inputs.select_jobs_explicitly && inputs.${inputName}) || (!inputs.select_jobs_explicitly && needs.ci_plan.outputs.${inputName} == 'true') }}`,
      `${jobName} must honor an explicit false input even when a scheduled caller invokes tests.yml`,
    );
  }

  assert.equal(
    testsWorkflow.jobs.ui.if,
    "${{ always() && ((inputs.select_jobs_explicitly && inputs.run_ui) || (!inputs.select_jobs_explicitly && needs.ci_plan.outputs.run_ui == 'true')) }}",
    'the stable UI aggregate must honor explicit selection and still report both child outcomes',
  );
  assert.deepEqual(testsWorkflow.jobs.ui.needs, ['ci_plan', 'ui-unit', 'ui-integration']);

  for (const [jobName, inputName] of [
    ['ui-e2e-wsrepl-lima', 'run_wsrepl_lima'],
    ['mobile-e2e-android', 'run_mobile_e2e_android'],
    ['mobile-e2e-ios', 'run_mobile_e2e_ios'],
    ['release-assets-docker', 'run_release_assets_docker'],
    ['e2e-core-slow', 'run_e2e_core_slow'],
    ['providers', 'run_providers'],
    ['release_actor_guard', 'run_providers'],
  ]) {
    assert.equal(
      testsWorkflow.jobs[jobName].if,
      `\${{ inputs.select_jobs_explicitly && inputs.${inputName} }}`,
      `${jobName} must honor explicit reusable inputs even when GitHub preserves the caller event`,
    );
  }

  for (const jobName of ['installers-smoke-linux', 'installers-smoke-macos', 'installers-smoke-windows']) {
    const env = testsWorkflow.jobs[jobName].env;
    for (const key of ['INSTALLERS_CHANNEL', 'INSTALLERS_SOURCE', 'INSTALLERS_REF', 'INSTALLERS_RELEASE_CHANNEL']) {
      assert.match(env[key], /inputs\.select_jobs_explicitly/);
      assert.doesNotMatch(env[key], /github\.event_name == 'workflow_call'/);
    }
  }

  assert.equal(
    testsWorkflow.jobs.stress.if,
    '${{ inputs.run_stress }}',
    'scheduled reusable callers must be able to enable the stress job through its authoritative run flag',
  );

  for (const workflowName of [
    'self-host-e2e.yml',
    'stress-tests.yml',
    'release.yml',
    'release-verify.yml',
    'providers-contracts.yml',
    'tests-dispatch.yml',
  ]) {
    const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', workflowName), 'utf8'));
    const reusableCalls = Object.entries(workflow.jobs ?? {})
      .filter(([, job]) => job?.uses === './.github/workflows/tests.yml');
    for (const [jobName, job] of reusableCalls) {
      assert.equal(job.with?.select_jobs_explicitly, true, `${workflowName}:${jobName} must opt into explicit selection`);
    }
  }
});

test('the CI collector rejects a requested lane that GitHub skipped', async () => {
  const result = await runInlineCollector({
    NEEDS_JSON: JSON.stringify({
      ci_plan: { result: 'success', outputs: {} },
      'release-assets-docker': { result: 'skipped', outputs: {} },
    }),
    SELECT_JOBS_EXPLICITLY: 'true',
    REQUEST_RUN_RELEASE_ASSETS_DOCKER: 'true',
  });
  assert.equal(result.status, 1, `collector accepted a requested skip:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /release-assets-docker.*requested.*skipped/i);
});

test('the CI collector rejects a skipped always-on admission lane', async () => {
  const result = await runInlineCollector({
    NEEDS_JSON: JSON.stringify({
      ci_plan: { result: 'success', outputs: {} },
      trusted_ref_guard: { result: 'skipped', outputs: {} },
    }),
    SELECT_JOBS_EXPLICITLY: 'false',
  });
  assert.equal(result.status, 1, `collector accepted a skipped admission lane:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /trusted_ref_guard.*requested.*skipped/i);
});

test('the CI collector rejects a classifier-selected lane that GitHub skipped', async () => {
  const result = await runInlineCollector({
    NEEDS_JSON: JSON.stringify({
      ci_plan: { result: 'success', outputs: { run_server: 'true', run_typecheck: 'true' } },
      server: { result: 'skipped', outputs: {} },
      typecheck: { result: 'skipped', outputs: {} },
    }),
    SELECT_JOBS_EXPLICITLY: 'false',
  });
  assert.equal(result.status, 1, `collector accepted a classifier-selected skip:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /server.*requested.*skipped/i);
  assert.match(result.stderr, /typecheck.*requested.*skipped/i);
});

test('the source-CI classifier fail-closes shared tooling and reaches direct root-owned tests', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8'));
  const changesStep = workflow.jobs.ci_plan.steps.find((step) => step.id === 'changes');
  const filterSource = changesStep?.with?.filters;
  assert.equal(typeof filterSource, 'string');
  assert.equal(changesStep.with['list-files'], 'json');
  const filters = YAML.parse(filterSource);

  assert.deepEqual(filters.changed, ['**']);
  assert.deepEqual(filters.documentation, ['**/*.md', '**/*.mdx']);

  for (const path of [
    'package.json',
    'yarn.lock',
    '.github/actions/enable-corepack-yarn/**',
    '.github/actions/install-yarn-dependencies/**',
    'scripts/workspaces/**',
  ]) {
    assert.ok(filters.all.includes(path), `${path} must select all source-CI lanes`);
  }
  assert.ok(filters.ui.includes('apps/bootstrap/**'));
  assert.ok(filters.ui.includes('scripts/generateBuiltInPrompts.mjs'));
  assert.ok(filters.ui.includes('scripts/generateBuiltInPrompts.test.mjs'));
  assert.ok(filters.ui.includes('skills/happier-diagnose/**'));
  assert.ok(filters.cli.includes('scripts/ensureCliCommonDistModule.mjs'));
  assert.ok(filters.cli.includes('scripts/ensureCliCommonDistModule.test.mjs'));

  const sharedRun = workflow.jobs['shared-packages-unit'].steps.map((step) => step.run ?? '').join('\n');
  assert.match(sharedRun, /generateBuiltInPrompts\.test\.mjs/);
  const cliRun = workflow.jobs.cli.steps.map((step) => step.run ?? '').join('\n');
  assert.match(cliRun, /ensureCliCommonDistModule\.test\.mjs/);

  const unmatchedStep = workflow.jobs.ci_plan.steps.find((step) => step.id === 'unmatched');
  assert.equal(unmatchedStep.if, '${{ !inputs.select_jobs_explicitly }}');
  assert.match(unmatchedStep.run, /classify-source-ci-paths\.mjs/);
  assert.equal(unmatchedStep.env.CHANGED_PATHS_JSON, '${{ steps.changes.outputs.changed_files }}');
  assert.equal(unmatchedStep.env.DOCUMENTATION_PATHS_JSON, '${{ steps.changes.outputs.documentation_files }}');
  for (const output of Object.values(workflow.jobs.ci_plan.outputs)) {
    assert.match(output, /steps\.unmatched\.outputs\.all == 'true'/);
  }
});
