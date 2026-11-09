import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { CLI_BINARY_TARGETS } from '../../packages/cli-common/src/componentArtifacts/targets.ts';

const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'));
const dependencies = (job) => Array.isArray(job.needs) ? job.needs : [job.needs];
function admitted(job, outputs, eventName, explicit = false) {
  return Function('inputs', 'needs', 'github', `return (${job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')});`)(
    { select_jobs_explicitly: explicit, run_self_host_schtasks: explicit },
    { ci_plan: { outputs } }, { event_name: eventName, ref_name: 'v0.3', base_ref: 'v0.3' });
}

test('source CI admits the release-only lanes before publication and on the nightly event', () => {
  assert.ok(workflow.on.schedule?.length, 'the existing Tests workflow must have a nightly trigger');
  const planner = workflow.jobs.ci_plan;
  assert.ok(planner, 'source CI needs its canonical planner');
  const selection = planner.steps.find((step) => step.run?.includes('resolve-source-validation-plan.mjs --pre-release-checks'));
  assert.ok(selection, 'source CI must invoke the source-validation owner');
  assert.equal(selection.env.EVENT_NAME, '${{ github.event_name }}');
  assert.match(selection.env.CHANGED_PATHS_JSON, /steps\.changes\.outputs\.changed_files/);
  for (const [id, output] of [
    ['self-host-schtasks-e2e', 'run_self_host_schtasks'],
    ['pre-release-packaged-cli', 'run_packaged_cli'],
    ['pre-release-mobile-native', 'run_mobile_native'],
  ]) {
    assert.equal(planner.outputs[output], '${{ steps.pre_release.outputs.' + output + ' }}');
    const job = workflow.jobs[id];
    assert.ok(job, `${id} must execute selected work`);
    assert.ok(dependencies(job).includes('ci_plan'));
    for (const event of ['push', 'pull_request', 'schedule']) {
      assert.equal(admitted(job, { [output]: 'true' }, event), true, `${event} must run ${id}`);
      assert.equal(admitted(job, { [output]: 'false' }, event), false, `unselected ${id} must skip`);
    }
    assert.ok(dependencies(workflow.jobs.ci_summary).includes(id), `${id} must reach the CI verdict`);
    if (workflow.jobs.gate) assert.ok(dependencies(workflow.jobs.gate).includes(id), `${id} must reach the v0.3 Gate`);
  }
  assert.equal(admitted(workflow.jobs['self-host-schtasks-e2e'], {}, 'workflow_call', true), true,
    'existing explicit release verification remains supported');
});

test('packaged CLI CI builds and executes every published target on its native runner', () => {
  const job = workflow.jobs['pre-release-packaged-cli'];
  assert.ok(job, 'the native CLI build matrix must be reachable');
  assert.deepEqual(job.strategy.matrix.include.map((entry) => entry.target).sort(),
    CLI_BINARY_TARGETS.map((entry) => `${entry.os}-${entry.arch}`).sort());
  assert.equal(job.strategy.matrix.include.find((entry) => entry.target === 'linux-arm64').runner, 'ubuntu-24.04-arm');
  const commands = job.steps.map((step) => step.run ?? '').join('\n');
  assert.match(commands, /build-cli-binaries/);
  assert.match(commands, /--targets "\$CLI_TARGET"/);
  assert.match(commands, /smokeTestArchive/);
  assert.doesNotMatch(commands, /--skip-smoke|--dry-run|publish-cli-binaries/);
  assert.equal(job.environment, undefined, 'pre-release builds must need no publication credentials');
});


test('every CI verdict rejects a selected pre-release failure or skip and accepts an irrelevant skip', () => {
  for (const collectorId of ['ci_summary', ...(workflow.jobs.gate ? ['gate'] : [])]) {
    const collector = workflow.jobs[collectorId];
    const script = collector.steps.find((step) => /Collect every lane conclusion|Require every selected check to succeed/.test(step.name)).run;
    const run = (job, output, result, selected) => {
      const needs = Object.fromEntries(dependencies(collector).map((id) => [id, { result: 'success', outputs: {} }]));
      needs.ci_plan.outputs = { run_packaged_cli: 'false', run_mobile_native: 'false', run_self_host_schtasks: 'false', [output]: String(selected) };
      needs[job].result = result;
      if (needs['gate-prepare']) needs['gate-prepare'].outputs = { packages: '[]', metadata_only: 'false', server_db_contract: 'false' };
      const scratch = mkdtempSync(join(tmpdir(), 'pre-release-ci-verdict-'));
      try {
        const executable = script.replace("'./scripts/release/ciSummaryCollector.mjs'",
          JSON.stringify(new URL('./ciSummaryCollector.mjs', import.meta.url).href));
        return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', executable], {
          cwd: scratch,
          encoding: 'utf8',
          env: { ...process.env, NEEDS_JSON: JSON.stringify(needs), CI_INPUTS_JSON: '{}', SELECT_JOBS_EXPLICITLY: 'false' },
        });
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    };
    for (const [job, output] of [
      ['pre-release-packaged-cli', 'run_packaged_cli'],
      ['pre-release-mobile-native', 'run_mobile_native'],
      ['self-host-schtasks-e2e', 'run_self_host_schtasks'],
    ]) {
      for (const result of ['success', 'failure', 'skipped']) {
        const actual = run(job, output, result, true);
        assert.equal(actual.status, result === 'success' ? 0 : 1, `${collectorId} selected ${job} ${result}: ${actual.stderr}`);
      }
      const irrelevant = run(job, output, 'skipped', false);
      assert.equal(irrelevant.status, 0, `${collectorId} irrelevant ${job} skip: ${irrelevant.stderr}`);
    }
  }
});


test('workflow planner command writes the nightly selection through GitHub outputs', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pre-release-plan-output-'));
  const output = join(scratch, 'github-output');
  try {
    const result = spawnSync(process.execPath, ['scripts/pipeline/release/resolve-source-validation-plan.mjs', '--pre-release-checks'], {
      cwd: new URL('../../', import.meta.url), encoding: 'utf8',
      env: { ...process.env, EVENT_NAME: 'schedule', CHANGED_PATHS_JSON: '[]', DEPLOY_TARGETS: '', GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('='))), {
      run_self_host_schtasks: 'true', run_packaged_cli: 'true', run_mobile_native: 'true',
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
