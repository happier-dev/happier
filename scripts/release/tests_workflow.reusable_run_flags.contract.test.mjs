import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('installer smoke selects the Windows-only payload promotion contract on test-only changes', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github/workflows/tests.yml'), 'utf8'));
  assert.equal(
    workflow.jobs['installers-smoke-windows'].steps.filter((step) => step.run?.includes('src/service/windows.test.ts')).length,
    1,
    'Windows CI must execute the PowerShell service contracts exactly once',
  );
  const classifier = workflow.jobs.ci_plan.steps.find((step) => step.id === 'changes');
  const filters = YAML.parse(classifier.with.filters);
  assert.ok(
    filters.installers_smoke.includes('scripts/release/installers_windows_payload_promotion.contract.test.mjs'),
    'the native Windows contract must select its installer-smoke execution owner',
  );
  for (const owner of ['packages/cli-common/src/service/**', 'apps/cli/src/daemon/service/**']) {
    assert.ok(filters.installers_smoke.includes(owner), `${owner} must select real Windows service tests`);
  }
  const windowsJob = workflow.jobs['installers-smoke-windows'];
  const wrapperTests = windowsJob.steps.find((step) => step.run?.includes('src/service/windows.test.ts'));
  assert.ok(wrapperTests, 'Windows CI must execute the PowerShell service contracts');
  assert.equal(wrapperTests['working-directory'], 'packages/cli-common');
  assert.equal(wrapperTests.if, undefined, 'service contracts must run for every selected Windows job');
});

test('shared CLI restoration handles a Windows drive path and preserves executable payloads', async (t) => {
  const action = YAML.parse(await readFile(join(repoRoot, '.github', 'actions', 'download-ci-cli-build', 'action.yml'), 'utf8'));
  const restore = action.runs.steps.find((step) => step.run);
  const scratch = mkdtempSync(join(tmpdir(), 'ci-cli-archive-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // On POSIX, model the drive prefix that GNU tar interprets as a remote host.
  const runnerTemp = process.platform === 'win32' ? scratch : join(scratch, 'D:', 'runner temp');
  const archiveDir = join(runnerTemp, 'ci-cli-build');
  const payloadDir = join(scratch, 'payload');
  const workspaceDir = join(scratch, 'workspace with spaces');
  for (const dir of [archiveDir, payloadDir, workspaceDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(payloadDir, 'built-cli'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(payloadDir, 'built-cli'), 0o755);
  const archive = spawnSync('tar', ['-cf', 'ci-cli-build.tar', '-C', payloadDir, 'built-cli'], {
    cwd: archiveDir, encoding: 'utf8',
  });
  assert.equal(archive.status, 0, archive.stderr);

  const restored = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', restore.run], {
    cwd: scratch,
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_TEMP: process.platform === 'win32' ? runnerTemp : 'D:/runner temp',
      GITHUB_WORKSPACE: workspaceDir,
    },
  });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(await readFile(join(workspaceDir, 'built-cli'), 'utf8'), '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') {
    const executed = spawnSync(join(workspaceDir, 'built-cli'), [], { encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.error?.message ?? executed.stderr);
  }
});

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

test('stable unit checks fail closed on admission failures and selected matrix skips', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github/workflows/tests.yml'), 'utf8'));
  const job = workflow.jobs['unit-summary'];
  assert.ok(job, 'required unit checks need an always-emitted matrix result owner');
  assert.equal(job.if, 'always()');
  assert.equal(job.name, '${{ matrix.name }}');
  assert.equal(job.strategy['fail-fast'], false);
  assert.deepEqual(job.strategy.matrix.include, [
    { lane: 'cli', name: 'CLI Unit Tests', selection: 'run_cli' },
    { lane: 'ui-unit', name: 'UI Unit Tests', selection: 'run_ui' },
  ]);
  for (const { lane } of job.strategy.matrix.include) assert.ok(job.needs.includes(lane));
  assert.ok(workflow.jobs.ci_summary.needs.includes('unit-summary'));
  const assertion = job.steps[0];
  assert.equal(assertion.env.UNIT_RESULT, '${{ needs[matrix.lane].result }}');
  assert.equal(assertion.env.PLAN_RESULT, '${{ needs.ci_plan.result }}');
  assert.equal(assertion.env.GUARD_RESULT, '${{ needs.trusted_ref_guard.result }}');
  assert.equal(assertion.env.SELECTED, "${{ (inputs.select_jobs_explicitly && inputs[matrix.selection]) || (!inputs.select_jobs_explicitly && needs.ci_plan.outputs[matrix.selection] == 'true') }}");
  for (const [selected, result, expected] of [
    ['true', 'success', 0], ['true', 'skipped', 1], ['true', 'failure', 1],
    ['true', 'cancelled', 1], ['true', '', 1], ['false', 'skipped', 0],
    ['false', 'success', 0], ['false', 'failure', 1],
  ]) {
    const outcome = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', assertion.run], {
      encoding: 'utf8',
      env: { ...process.env, SELECTED: selected, UNIT_RESULT: result, PLAN_RESULT: 'success', GUARD_RESULT: 'success' },
    });
    assert.equal(outcome.status, expected, `${selected}/${result}: ${outcome.stderr}`);
  }
  for (const [plan, guard] of [['failure', 'success'], ['success', 'skipped'], ['cancelled', 'success']]) {
    const outcome = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', assertion.run], {
      encoding: 'utf8',
      env: { ...process.env, SELECTED: 'false', UNIT_RESULT: 'skipped', PLAN_RESULT: plan, GUARD_RESULT: guard },
    });
    assert.equal(outcome.status, 1, `admission ${plan}/${guard}: ${outcome.stderr}`);
  }
});

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
  const defaultSuiteInputs = new Map([
    ['ui-e2e', 'run_ui_e2e'],
    ['ui-unit', 'run_ui'],
    ['ui-integration', 'run_ui'],
    ['shared-packages-unit', 'run_shared_packages'],
    ['server', 'run_server'],
    ['server-db-contract', 'run_server_db_contract'],
    ['stack', 'run_stack'],
    ['release-contracts', 'run_release_contracts'],
    ['binary-smoke', 'run_binary_smoke'],
    ['build-smoke', 'run_build_smoke'],
    ['typecheck', 'run_typecheck'],
    ['cli-daemon-e2e', 'run_cli_daemon_e2e'],
    ['e2e-core', 'run_e2e_core'],
  ]);

  for (const [jobName, inputName] of defaultSuiteInputs) {
    const selector = `(inputs.select_jobs_explicitly && inputs.${inputName}) || (!inputs.select_jobs_explicitly && needs.ci_plan.outputs.${inputName} == 'true')`;
    const condition = String(testsWorkflow.jobs[jobName].if);
    // Build consumers may only prepend admission conjuncts; the selection itself stays authoritative.
    const admission = condition.startsWith('${{ ') && condition.endsWith(` && (${selector}) }}`)
      ? condition.slice(4, -(` && (${selector}) }}`).length).split(' && ')
      : null;
    assert.ok(
      condition === `\${{ ${selector} }}`
        || admission?.every((term) => term === '!cancelled()' || /^needs\.[\w-]+\.result == 'success'$/.test(term)),
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
    ['mobile-e2e-android', 'run_mobile_e2e_android'],
    ['mobile-e2e-ios', 'run_mobile_e2e_ios'],
    ['release-assets-docker', 'run_release_assets_docker'],
    ['e2e-core-slow', 'run_e2e_core_slow'],
    ['providers', 'run_providers'],
    ['release_actor_guard', 'run_providers'],
  ]) {
    const selector = `inputs.select_jobs_explicitly && inputs.${inputName}`;
    const condition = String(testsWorkflow.jobs[jobName].if);
    const admission = condition.startsWith('${{ ') && condition.endsWith(` && ${selector} }}`)
      ? condition.slice(4, -(` && ${selector} }}`).length).split(' && ')
      : null;
    assert.ok(
      condition === `\${{ ${selector} }}`
        || admission?.every((term) => term === '!cancelled()' || /^needs\.[\w-]+\.result == 'success'$/.test(term)),
      `${jobName} must honor explicit reusable inputs even when GitHub preserves the caller event`,
    );
  }

  assert.equal(testsWorkflow.on.workflow_call.inputs.run_wsrepl_lima, undefined);
  assert.equal(testsWorkflow.jobs['ui-e2e-wsrepl-lima'], undefined);

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

  for (const workflowName of [
    'self-host-e2e.yml',
    'stress-tests.yml',
    'release-verify.yml',
    'release-source-validation.yml',
    'providers-contracts.yml',
  ]) {
    const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', workflowName), 'utf8'));
    const reusableCalls = Object.entries(workflow.jobs ?? {}).filter(([, job]) => job?.uses === './.github/workflows/tests.yml');
    for (const [jobName, job] of reusableCalls) {
      assert.equal(job.with?.run_shared_packages, false, `${workflowName}:${jobName} must select shared packages explicitly`);
      assert.equal(job.with?.run_build_smoke, false, `${workflowName}:${jobName} must select build smoke explicitly`);
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

test('the CI collector owns explicit build-smoke and shared-package selections', async () => {
  const result = await runInlineCollector({
    NEEDS_JSON: JSON.stringify({
      ci_plan: { result: 'success', outputs: {} },
      'build-smoke': { result: 'skipped', outputs: {} },
      'shared-packages-unit': { result: 'skipped', outputs: {} },
    }),
    SELECT_JOBS_EXPLICITLY: 'true',
    REQUEST_RUN_BUILD_SMOKE: 'true',
    REQUEST_RUN_SHARED_PACKAGES: 'true',
  });
  assert.equal(result.status, 1, `collector accepted requested skips:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /build-smoke.*requested.*skipped/i);
  assert.match(result.stderr, /shared-packages-unit.*requested.*skipped/i);
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
    'scripts/ci/corepack-prepare-yarn-with-retry.sh',
    '.github/actions/install-yarn-dependencies/**',
    'scripts/workspaces/**',
  ]) {
    assert.ok(filters.all.includes(path), `${path} must select all source-CI lanes`);
  }
  assert.ok(filters.ui.includes('apps/bootstrap/**'));
  for (const setupOwner of ['apps/bootstrap/**', 'packages/cli-common/**']) {
    assert.ok(filters.ui_e2e.includes(setupOwner), `${setupOwner} must select the composed real-hsetup browser lane even in an otherwise classified PR`);
  }
  assert.match(workflow.jobs.ci_plan.outputs.run_ui_e2e, /steps\.changes\.outputs\.ui_e2e == 'true'/);
  assert.ok(filters.ui.includes('scripts/generateBuiltInPrompts.mjs'));
  assert.ok(filters.ui.includes('scripts/generateBuiltInPrompts.test.mjs'));
  assert.ok(filters.ui.includes('skills/happier-diagnose/**'));
  assert.ok(filters.cli.includes('scripts/ensureCliCommonDistModule.mjs'));
  assert.ok(filters.cli.includes('scripts/ensureCliCommonDistModule.test.mjs'));
  for (const lane of ['ui', 'server', 'cli', 'stack']) {
    assert.ok(!filters[lane].includes('packages/**'), `${lane} must use workspace dependency closure instead of broad package fanout`);
  }
  assert.match(workflow.jobs.ci_plan.outputs.run_ui, /steps\.unmatched\.outputs\.ui == 'true'/);
  assert.match(workflow.jobs.ci_plan.outputs.run_server, /steps\.unmatched\.outputs\.server == 'true'/);
  assert.match(workflow.jobs.ci_plan.outputs.run_cli, /steps\.unmatched\.outputs\.cli == 'true'/);
  assert.match(workflow.jobs.ci_plan.outputs.run_stack, /steps\.unmatched\.outputs\.stack == 'true'/);
  assert.match(workflow.jobs.ci_plan.outputs.run_shared_packages, /steps\.unmatched\.outputs\.shared_packages == 'true'/);
  assert.match(workflow.jobs.ci_plan.outputs.run_build_smoke, /steps\.changes\.outputs\.changed == 'true'/);
  assert.match(workflow.jobs['shared-packages-unit'].if, /needs\.ci_plan\.outputs\.run_shared_packages == 'true'/);

  assert.match(workflow.jobs['shared-packages-unit'].steps.map((step) => step.run ?? '').join('\n'), /yarn -s test:shared-packages:local/u);
  const cliRun = workflow.jobs.cli.steps.map((step) => step.run ?? '').join('\n');
  assert.match(cliRun, /ensureCliCommonDistModule\.test\.mjs/);

  const unmatchedStep = workflow.jobs.ci_plan.steps.find((step) => step.id === 'unmatched');
  assert.equal(unmatchedStep.if, '${{ !inputs.select_jobs_explicitly }}');
  assert.match(unmatchedStep.run, /classify-source-ci-paths\.mjs/);
  assert.equal(unmatchedStep.env.CHANGED_PATHS_JSON, '${{ steps.changes.outputs.changed_files }}');
  assert.equal(unmatchedStep.env.DOCUMENTATION_PATHS_JSON, '${{ steps.changes.outputs.documentation_files }}');
  for (const [name, output] of Object.entries(workflow.jobs.ci_plan.outputs)) {
    if (!name.startsWith('run_')) continue;
    assert.match(output, /steps\.unmatched\.outputs\.all == 'true'/);
  }
});

test('protected pushes cover the complete source except planner-validated notes-only deltas', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['dev', 'preview', 'main']);

  for (const outputName of ['run_ui', 'run_server', 'run_cli', 'run_stack', 'run_typecheck', 'run_e2e_core']) {
    assert.match(
      workflow.jobs.ci_plan.outputs[outputName],
      /github\.event_name == 'push'/,
      `${outputName} must cover the whole protected-branch head instead of only the latest push delta`,
    );
  }

  const notes = workflow.jobs.ci_plan.steps.find((step) => step.id === 'notes');
  assert.equal(workflow.jobs.ci_plan.permissions.actions, 'read');
  assert.equal(notes.env.CI_BASE_SHA, '${{ github.event.before }}');
  assert.equal(notes.env.CI_SOURCE_SHA, '${{ github.sha }}');
  assert.match(notes.run, /classify-source-ci-paths\.mjs --notes-only/);
  assert.match(notes.run, /node --test scripts\/release\/release_notes_projection\.contract\.test\.mjs/);
  for (const [name, output] of Object.entries(workflow.jobs.ci_plan.outputs)) {
    if (!name.startsWith('run_')) continue;
    assert.match(output, /steps\.notes\.outputs\.notes_only != 'true' && \(/);
  }

  for (const outputName of [
    'run_ui_e2e', 'run_server_db_contract', 'run_release_contracts', 'run_installers_smoke',
    'run_binary_smoke', 'run_cli_daemon_e2e',
  ]) {
    assert.doesNotMatch(
      workflow.jobs.ci_plan.outputs[outputName],
      /github\.event_name == 'push'/,
      `${outputName} should remain path-selected rather than expanding ordinary source CI into release/deep certification`,
    );
  }
});
