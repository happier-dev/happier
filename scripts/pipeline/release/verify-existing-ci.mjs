#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { projectSourceSuiteReuse } from './source-suite-evidence.mjs';

const TRUSTED_CI_EVENTS = new Set(['push', 'workflow_dispatch', 'merge_group']);

/**
 * @param {unknown[]} runs
 * @param {{ repository: string; sourceSha: string; sourceBranch: string }} expected
 */
export function selectExactCanonicalCiRun(runs, expected) {
  const matches = runs.filter((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const run = /** @type {Record<string, any>} */ (value);
    return run.head_sha === expected.sourceSha
      && run.head_branch === expected.sourceBranch
      && TRUSTED_CI_EVENTS.has(run.event)
      && run.head_repository?.full_name === expected.repository;
  }).sort((left, right) => Number(/** @type {any} */ (right).id) - Number(/** @type {any} */ (left).id));
  if (matches.length === 0) {
    throw new Error(`No exact-SHA canonical CI exists for ${expected.repository}@${expected.sourceSha} on ${expected.sourceBranch}`);
  }
  return /** @type {Record<string, any>} */ (matches[0]);
}

export function selectExactSuccessfulCiRun(runs, expected) {
  const run = selectExactCanonicalCiRun(runs, expected);
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Exact-SHA canonical CI ${run.id} is ${run.status}/${run.conclusion ?? 'pending'}, not completed/success`);
  }
  return run;
}

export function buildWorkflowRunsEndpoint(repository, workflow, sourceBranch, sourceSha) {
  return `repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(sourceBranch)}&head_sha=${encodeURIComponent(sourceSha)}&per_page=100`;
}

function fetchWorkflowRun(repository, runId) {
  const result = spawnSync('gh', ['api', 'repos/' + repository + '/actions/runs/' + runId], { encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || '').trim());
  return JSON.parse(String(result.stdout ?? ''));
}

function fetchWorkflowRuns(repository, workflow, sourceBranch, sourceSha) {
  const endpoint = buildWorkflowRunsEndpoint(repository, workflow, sourceBranch, sourceSha);
  const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || '').trim());
  const parsed = JSON.parse(String(result.stdout ?? ''));
  if (!Array.isArray(parsed.workflow_runs)) throw new Error('GitHub workflow-runs response is missing workflow_runs');
  return parsed.workflow_runs;
}

/** A metadata child may consume source evidence only from a non-metadata gate.
 * @param {{repository: string; sourceSha: string; sourceBranch: string; runId: string}} expected
 */
export async function verifyCanonicalGateBaseline(expected) {
  const run = fetchWorkflowRun(expected.repository, expected.runId);
  selectExactSuccessfulCiRun([run], expected);
  if (String(run.id) !== expected.runId || run.path !== '.github/workflows/tests.yml' || run.event !== 'push') throw new Error('Invalid canonical gate baseline run');
  const root = await mkdtemp(join(tmpdir(), 'happier-gate-baseline-'));
  try {
    const download = spawnSync('gh', ['run', 'download', expected.runId, '--repo', expected.repository, '--name', 'ci-lane-summary', '--dir', root], { encoding: 'utf8' });
    if (download.error) throw download.error;
    if (download.status !== 0) throw new Error('Cannot download gate baseline evidence');
    const summary = JSON.parse(await readFile(join(root, 'ci-summary.json'), 'utf8'));
    if (summary.schemaVersion !== 1 || String(summary.runId) !== expected.runId || summary.sourceSha !== expected.sourceSha
      || !Array.isArray(summary.failures) || summary.failures.length || !Array.isArray(summary.lanes)) throw new Error('Invalid gate baseline summary');
    const lanes = new Map(summary.lanes.map((lane) => [lane.id, lane]));
    const outputs = lanes.get('gate-prepare')?.outputs;
    if (outputs?.metadata_only !== 'false') throw new Error('Baseline must contain original source gates');
    for (const id of ['gate-prepare', 'gate-compiler', 'gate-build-artifacts', 'installers-smoke-windows']) {
      if (lanes.get(id)?.result !== 'success') throw new Error(`Baseline ${id} did not succeed`);
    }
    if (lanes.get('gate-unit')?.result !== 'success' && !(outputs.packages === '[]' && lanes.get('gate-unit')?.result === 'skipped')) throw new Error('Baseline source units did not succeed');
    if (lanes.get('server-db-contract')?.result !== 'success' && !(outputs.server_db_contract === 'false' && lanes.get('server-db-contract')?.result === 'skipped')) throw new Error('Baseline database contract did not succeed');
  } finally { await rm(root, { recursive: true, force: true }); }
  return run;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repository: { type: 'string' }, workflow: { type: 'string', default: 'tests.yml' },
      'source-sha': { type: 'string' }, 'source-branch': { type: 'string' },
      'run-id': { type: 'string', default: '' },
      'github-output': { type: 'string', default: '' },
      'source-profile': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const sourceProfile = String(values['source-profile'] ?? '').trim();
  if (sourceProfile && !['integrated', 'stable'].includes(sourceProfile)) throw new Error('Unsupported source validation profile');
  const repository = String(values.repository ?? '').trim();
  const workflow = String(values.workflow ?? '').trim();
  const sourceSha = String(values['source-sha'] ?? '').trim();
  const sourceBranch = String(values['source-branch'] ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('--repository must be owner/repo');
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error('--source-sha must be a full lowercase commit ID');
  if (!['v0.3', 'dev', 'preview', 'main'].includes(sourceBranch)) throw new Error('--source-branch must be v0.3, dev, preview, or main');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/u.test(workflow)) throw new Error('--workflow must be a workflow filename');
  const expected = { repository, sourceSha, sourceBranch };
  const requestedRunId = String(values['run-id'] ?? '').trim();
  let run;
  if (requestedRunId) {
    if (!/^[1-9][0-9]*$/u.test(requestedRunId)) throw new Error('--run-id must be a positive integer');
    run = fetchWorkflowRun(repository, requestedRunId);
    if (run.path !== '.github/workflows/' + workflow || run.head_sha !== sourceSha || run.head_branch !== sourceBranch || run.event !== 'push' || run.head_repository?.full_name !== repository || run.status !== 'completed' || run.conclusion !== 'success') {
      throw new Error('CI run ' + requestedRunId + ' is not a successful canonical push CI for the requested source');
    }
  } else {
    let runs = fetchWorkflowRuns(repository, workflow, sourceBranch, sourceSha);
    const observed = selectExactCanonicalCiRun(runs, expected);
    if (observed.status !== 'completed') {
      // The exact source's CI is still running: wait for it to settle instead of refusing the release.
      process.stderr.write(`Waiting for exact-SHA CI ${observed.id} (${observed.status})...\n`);
      const watched = spawnSync('gh', ['run', 'watch', String(observed.id), '--repo', repository, '--exit-status', '--interval', '60'], { stdio: 'inherit', env: process.env });
      if (watched.error) throw watched.error;
      if (watched.status !== 0) throw new Error(`Exact-SHA CI ${observed.id} did not complete successfully`);
      runs = fetchWorkflowRuns(repository, workflow, sourceBranch, sourceSha);
    }
    run = selectExactSuccessfulCiRun(runs, expected);
  }
  let sourceSuiteReuse = {};
  if (sourceProfile) {
    const root = await mkdtemp(join(tmpdir(), 'happier-source-suites-'));
    try {
      const download = spawnSync('gh', ['run', 'download', String(run.id), '--repo', repository, '--name', 'ci-lane-summary', '--dir', root], { encoding: 'utf8' });
      if (download.error || download.status !== 0) throw new Error('Source suite summary unavailable');
      sourceSuiteReuse = projectSourceSuiteReuse(JSON.parse(await readFile(join(root, 'ci-summary.json'), 'utf8')), { runId: String(run.id), sourceSha, profile: sourceProfile });
    } catch {
      // Older CI remains valid ordinary evidence; absent suite proof runs the suite.
      sourceSuiteReuse = projectSourceSuiteReuse(null, { runId: String(run.id), sourceSha, profile: sourceProfile });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  const output = { runId: Number(run.id), runUrl: String(run.html_url ?? ''), sourceSha, sourceBranch };
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) await appendFile(githubOutput, `ci_run_id=${output.runId}\nci_run_url=${output.runUrl}\n${Object.entries(sourceSuiteReuse).map(([key, value]) => `${key}=${value}\n`).join('')}`, 'utf8');
  else process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
