import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(await readFile(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'));

test('network plan distinguishes dev, relevant PRs and the editorial-only exemption', () => {
  const expression = workflow.jobs.ci_plan.outputs.run_network_transfer.slice(3, -2);
  const evaluate = (event, ref, changed, notes = '') => Function('github', 'steps', `return Boolean(${expression})`)(
    { event_name: event, ref },
    { notes: { outputs: { notes_only: notes } }, unmatched: { outputs: { all: '' } }, changes: { outputs: { all: '', network_transfer: changed } } },
  );
  assert.equal(evaluate('push', 'refs/heads/dev', ''), true);
  assert.equal(evaluate('push', 'refs/heads/preview', ''), false);
  assert.equal(evaluate('pull_request', 'refs/pull/1/merge', 'true'), true);
  assert.equal(evaluate('pull_request', 'refs/pull/1/merge', ''), false);
  assert.equal(evaluate('push', 'refs/heads/dev', '', 'true'), false);
});

test('the all-lane collector preserves PR report-only failures while dev and unrelated failures remain blocking', async () => {
  const collector = workflow.jobs.ci_summary.steps[0].run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const directory = await mkdtemp(join(tmpdir(), 'network-ci-contract-'));
  try {
    for (const [advisory, networkResult, otherResult, expected] of [
      ['true', 'failure', 'success', 0], ['false', 'failure', 'success', 1],
      ['true', 'failure', 'failure', 1], ['false', 'skipped', 'success', 1],
    ]) {
      const needs = { ci_plan: { result: 'success', outputs: { run_network_transfer: 'true' } }, trusted_ref_guard: { result: 'success' },
        'network-transfer': { result: networkResult }, typecheck: { result: otherResult } };
      const result = spawnSync(process.execPath, ['--input-type=module'], { input: collector, cwd: directory, encoding: 'utf8',
        env: { ...process.env, NEEDS_JSON: JSON.stringify(needs), NETWORK_TRANSFER_REPORT_ONLY: advisory } });
      assert.equal(result.status, expected, result.stderr);
      const summary = JSON.parse(await readFile(join(directory, 'ci-summary.json'), 'utf8'));
      assert.equal(summary.lanes.find((lane) => lane.id === 'network-transfer').result, networkResult);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('network transfer is admitted by the canonical plan for dev pushes and sync/server/socket PRs', () => {
  const plan = workflow.jobs.ci_plan;
  assert.ok(plan.outputs.run_network_transfer, 'default CI must select the network workload');
  assert.match(plan.outputs.run_network_transfer, /github.event_name == 'push'.*refs\/heads\/dev/);
  assert.match(plan.outputs.run_network_transfer, /steps.changes.outputs.network_transfer == 'true'/);
  assert.match(plan.outputs.run_network_transfer, /steps.unmatched.outputs.all == 'true'/);
  const filters = YAML.parse(plan.steps.find((step) => step.id === 'changes').with.filters);
  for (const path of ['apps/ui/sources/sync/**', 'apps/server/**', 'apps/cli/src/api/**', 'packages/tests/**']) {
    assert.ok(filters.network_transfer.includes(path), path);
  }
  const job = workflow.jobs['network-transfer'];
  assert.match(job.if, /needs.ci_plan.outputs.run_network_transfer == 'true'/);
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  assert.match(job['continue-on-error'], /github.event_name == 'pull_request'/);
  assert.match(job['continue-on-error'], /!inputs.network_transfer_enforce/);
  assert.ok(workflow.jobs.ci_summary.needs.includes('network-transfer'));
});

test('network results are compared and retained after failure without granting write credentials', () => {
  const job = workflow.jobs['network-transfer'];
  assert.ok(job, 'network workload must have an invoked job');
  const run = job.steps.find((step) => step.name === 'Measure network transfer');
  assert.match(run.run, /session.networkTransfer.spec.ts/);
  const compare = job.steps.find((step) => step.name === 'Compare network transfer');
  assert.match(compare.if, /!cancelled\(\)/);
  assert.match(compare.run, /network-transfer-report/);
  assert.equal(compare.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(compare.env.NETWORK_TRANSFER_BASE_BRANCH, "${{ github.base_ref || 'dev' }}");
  assert.match(compare.env.NETWORK_TRANSFER_ENFORCE, /github.event_name == 'push'.*refs\/heads\/dev/);
  const upload = job.steps.find((step) => step.name === 'Upload network transfer measurements');
  assert.match(upload.if, /!cancelled\(\)/);
  assert.equal(upload.with.name, 'ui-e2e-network-transfer');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.doesNotMatch(JSON.stringify(job), /write|pull_request_target/);
});
