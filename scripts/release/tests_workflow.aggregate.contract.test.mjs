import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { resolveVitestShardRange } from '../../apps/cli/scripts/runVitestShards.mjs';

function jobIds(raw) {
  const jobs = raw.slice(raw.indexOf('\njobs:'));
  return [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]).filter((id) => id !== 'ci_summary');
}

test('tests workflow summary covers every top-level CI lane', async () => {
  const raw = await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8');
  const summary = raw.match(/\n  ci_summary:[\s\S]*?\n  [A-Za-z0-9_-]+:/)?.[0] ?? raw.slice(raw.indexOf('\n  ci_summary:'));
  const needs = summary.match(/needs: \[([^\]]+)\]/)?.[1]?.split(',').map((id) => id.trim()).filter(Boolean) ?? [];
  assert.ok(needs.length > 0, 'ci_summary must declare its lane dependencies');
  assert.deepEqual(new Set(needs), new Set(jobIds(raw)), 'ci_summary.needs must stay synchronized with every top-level CI lane');
  assert.match(raw, /result !== 'success' && result !== 'skipped'/, 'collector must fail closed for every non-success lane result');
  assert.doesNotMatch(raw, /\["failure","cancelled"\]\.includes\(v\.result\)/, 'collector must not ignore timeout/startup/stale conclusions');
  assert.match(raw, /ci-summary\.json/, 'collector must write a machine-readable summary artifact');
  assert.match(
    summary,
    /CI_SOURCE_SHA:\s*\$\{\{ inputs\.checkout_sha != '' && inputs\.checkout_sha \|\| github\.sha \}\}/,
    'the summary must bind the exact requested checkout rather than the reusable caller SHA',
  );
  assert.match(raw, /name: Upload machine-readable CI summary[\s\S]*?if: always\(\)/, 'summary artifact must upload even when a lane fails');
});

test('selected owner jobs collect every independent diagnostic before failing', async () => {
  const raw = await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);

  const expectedChecks = {
    cli: ['unit-tests', 'import-cycles', 'cli-common-dist', 'integration-tests', 'slow-tests'],
    'release-contracts': ['release-contracts', 'release-sync-installers'],
    typecheck: [
      'wiring-self',
      'policy-self',
      'wiring-validator',
      'inventory',
      'migration-inventory',
      'workspace-typecheck',
    ],
  };

  for (const [jobId, expectedIds] of Object.entries(expectedChecks)) {
    const steps = workflow.jobs[jobId].steps;
    const outcomeSteps = steps.filter((step) => expectedIds.includes(step.id));
    assert.deepEqual(
      outcomeSteps.map((step) => step.id),
      expectedIds,
      `${jobId} must expose each independent diagnostic as its own outcome-bearing step`,
    );
    for (const step of outcomeSteps) {
      assert.equal(step['continue-on-error'], true, `${jobId}.${step.id} must not hide reachable sibling failures`);
    }
    for (const step of outcomeSteps.slice(1)) {
      assert.match(String(step.if), /!cancelled\(\)/, `${jobId}.${step.id} must run after a sibling failure`);
    }

    const assertion = steps.at(-1);
    assert.equal(String(assertion.if), 'always()', `${jobId} must end with an always-run owner assertion`);
    for (const expectedId of expectedIds) {
      assert.ok(
        Object.values(assertion.env ?? {}).includes(`\${{ steps.${expectedId}.outcome }}`),
        `${jobId} final assertion must consume ${expectedId}.outcome`,
      );
    }
  }
});

test('CLI source checks retain trusted admission after a failed build and artifact consumers require a download', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const job = workflow.jobs.cli;
  assert.match(job.if, /always\(\)/, 'a failed build must not suppress source checks');
  assert.match(job.if, /!cancelled\(\)/);
  assert.match(job.if, /needs\.ci_plan\.result == 'success'/);
  assert.match(job.if, /needs\.trusted_ref_guard\.result == 'success'/);
  assert.match(job.if, /inputs\.select_jobs_explicitly && inputs\.run_cli/);
  assert.match(job.if, /needs\.ci_plan\.outputs\.run_cli == 'true'/);
  const downloadIndex = job.steps.findIndex((step) => step.id === 'cli-build');
  assert.ok(downloadIndex > job.steps.findIndex((step) => step.id === 'import-cycles'));
  assert.match(job.steps[downloadIndex].if, /needs\.build-cli\.result == 'success'/);
  assert.equal(job.steps[downloadIndex]['continue-on-error'], true);
  for (const id of ['cli-common-dist', 'integration-tests', 'slow-tests']) {
    assert.match(job.steps.find((step) => step.id === id).if, /steps\.cli-build\.outcome == 'success'/);
  }
  const unit = job.steps.find((step) => step.id === 'unit-tests');
  const guard = job.steps.find((step) => step.id === 'import-cycles');
  assert.match(unit.run, /test:unit:vitest/);
  assert.doesNotMatch(unit.run, /test:unit(?:\s|$)/);
  assert.match(guard.run, /test:import-cycles/);
  assert.match(guard.if, /matrix\.part == 1 && !cancelled\(\)/);
  assert.equal(job.strategy['fail-fast'], false);
});

test('CLI result assertion reports all source failures and accepts unavailable artifact lanes only after an upstream failure', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const assertion = workflow.jobs.cli.steps.at(-1);
  const baseEnv = {
    ...process.env,
    CLI_PART: '1',
    CLI_BUILD_RESULT: 'success',
    CLI_BUILD_OUTCOME: 'success',
    UNIT_TESTS_OUTCOME: 'success',
    IMPORT_CYCLES_OUTCOME: 'success',
    CLI_COMMON_DIST_OUTCOME: 'success',
    INTEGRATION_TESTS_OUTCOME: 'success',
    SLOW_TESTS_OUTCOME: 'success',
  };
  for (const [overrides, expected] of [
    [{}, 0],
    [{ CLI_BUILD_RESULT: 'failure', CLI_BUILD_OUTCOME: 'skipped', CLI_COMMON_DIST_OUTCOME: 'skipped', INTEGRATION_TESTS_OUTCOME: 'skipped', SLOW_TESTS_OUTCOME: 'skipped' }, 0],
    [{ CLI_BUILD_OUTCOME: 'failure', CLI_COMMON_DIST_OUTCOME: 'skipped', INTEGRATION_TESTS_OUTCOME: 'skipped', SLOW_TESTS_OUTCOME: 'skipped' }, 1],
    [{ UNIT_TESTS_OUTCOME: 'failure', IMPORT_CYCLES_OUTCOME: 'failure' }, 1],
    [{ IMPORT_CYCLES_OUTCOME: 'failure' }, 1],
    [{ INTEGRATION_TESTS_OUTCOME: 'failure' }, 1],
    [{ SLOW_TESTS_OUTCOME: 'failure' }, 1],
    [{ SLOW_TESTS_OUTCOME: 'skipped' }, 1],
    [{ CLI_PART: '2', IMPORT_CYCLES_OUTCOME: 'skipped', CLI_COMMON_DIST_OUTCOME: 'skipped', INTEGRATION_TESTS_OUTCOME: 'skipped', SLOW_TESTS_OUTCOME: 'skipped' }, 0],
  ]) {
    const result = spawnSync('bash', ['-e', '-c', assertion.run], { env: { ...baseEnv, ...overrides }, encoding: 'utf8' });
    assert.equal(result.status, expected, JSON.stringify({ overrides, stderr: result.stderr }));
  }
});

test('CI summary attributes skipped binary consumers to the failed build while retaining independent failures', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const collector = workflow.jobs.ci_summary.steps[0].run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const consumers = ['binary-smoke', 'installers-smoke-linux', 'installers-smoke-macos', 'installers-smoke-windows', 'e2e-core', 'e2e-core-slow', 'cli-daemon-e2e'];
  const needs = {
    ci_plan: { result: 'success' },
    trusted_ref_guard: { result: 'success' },
    'build-cli': { result: 'failure' },
    cli: { result: 'failure' },
    ...Object.fromEntries(consumers.map((id) => [id, { result: 'skipped' }])),
  };
  const cwd = await mkdtemp(join(tmpdir(), 'ci-02-summary-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: collector,
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NEEDS_JSON: JSON.stringify(needs),
        SELECT_JOBS_EXPLICITLY: 'true',
        REQUEST_RUN_CLI: 'true',
        REQUEST_RUN_BINARY_SMOKE: 'true',
        REQUEST_RUN_INSTALLERS_SMOKE: 'true',
        REQUEST_RUN_E2E_CORE: 'true',
        REQUEST_RUN_E2E_CORE_SLOW: 'true',
        REQUEST_RUN_CLI_DAEMON_E2E: 'true',
      },
    });
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(await readFile(join(cwd, 'ci-summary.json'), 'utf8'));
    assert.ok(summary.failures.some((lane) => lane.id === 'build-cli' && lane.result === 'failure'));
    assert.ok(summary.failures.some((lane) => lane.id === 'cli' && lane.result === 'failure'));
    for (const id of consumers) {
      assert.equal(summary.failures.find((lane) => lane.id === id).reason, 'blocked by build-cli (failure)');
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CLI integration covers every shard despite the unit-job partition', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const job = workflow.jobs.cli;
  const integration = job.steps.find((step) => step.name === 'Run integration tests');
  assert.ok(integration, 'CLI integration must remain scheduled');
  // A single-part integration step must not inherit the two-part unit partition.
  const selectedParts = String(integration.if).includes('matrix.part == 1') ? [1] : job.strategy.matrix.part;
  const covered = new Set();
  for (const part of selectedParts) {
    const range = resolveVitestShardRange({ ...job.env, HAPPIER_CLI_VITEST_PART: String(part), ...integration.env }, 8);
    for (let shard = range.start; shard <= range.end; shard += 1) covered.add(shard);
  }
  assert.deepEqual([...covered].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('consumers of a skip-tolerant job declare explicit admission', async () => {
  const workflow = YAML.parse(await readFile(join(process.cwd(), '.github/workflows/tests.yml'), 'utf8'));
  const needsOf = (id) => [workflow.jobs[id]?.needs ?? []].flat();
  // A job that admits a skipped need can succeed above a skipped ancestor. GitHub's implicit
  // success() on a consumer without a status function still sees that skip and drops the lane.
  const skipTolerant = new Set(Object.keys(workflow.jobs).filter((id) => /result == 'skipped'/.test(String(workflow.jobs[id].if ?? ''))));
  const statusFunction = /\b(?:always|success|failure|cancelled)\(\)/;
  const implicit = Object.keys(workflow.jobs).filter((id) => (
    id !== 'ci_summary'
    && needsOf(id).some((parent) => skipTolerant.has(parent))
    && !statusFunction.test(String(workflow.jobs[id].if ?? ''))
  ));
  assert.ok(skipTolerant.has('build-cli'), 'build-cli admits the optional launcher skip');
  assert.deepEqual(implicit, [], 'an optional ancestor skip must not silently skip a requested lane');
});
