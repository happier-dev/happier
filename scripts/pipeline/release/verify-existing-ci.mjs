#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * @param {unknown[]} runs
 * @param {{ repository: string; sourceSha: string; sourceBranch: string }} expected
 */
export function selectExactSuccessfulCiRun(runs, expected) {
  const matches = runs.filter((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const run = /** @type {Record<string, any>} */ (value);
    return run.head_sha === expected.sourceSha
      && run.head_branch === expected.sourceBranch
      && run.event === 'push'
      && run.status === 'completed'
      && run.conclusion === 'success'
      && run.head_repository?.full_name === expected.repository;
  }).sort((left, right) => Number(/** @type {any} */ (right).id) - Number(/** @type {any} */ (left).id));
  if (matches.length === 0) {
    throw new Error(`No successful exact-SHA push CI exists for ${expected.repository}@${expected.sourceSha} on ${expected.sourceBranch}`);
  }
  return /** @type {Record<string, any>} */ (matches[0]);
}

function fetchWorkflowRuns(repository, workflow, sourceBranch) {
  const endpoint = `repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(sourceBranch)}&event=push&status=success&per_page=100`;
  const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || '').trim());
  const parsed = JSON.parse(String(result.stdout ?? ''));
  if (!Array.isArray(parsed.workflow_runs)) throw new Error('GitHub workflow-runs response is missing workflow_runs');
  return parsed.workflow_runs;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repository: { type: 'string' }, workflow: { type: 'string', default: 'tests.yml' },
      'source-sha': { type: 'string' }, 'source-branch': { type: 'string' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const repository = String(values.repository ?? '').trim();
  const workflow = String(values.workflow ?? '').trim();
  const sourceSha = String(values['source-sha'] ?? '').trim();
  const sourceBranch = String(values['source-branch'] ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('--repository must be owner/repo');
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error('--source-sha must be a full lowercase commit ID');
  if (!['dev', 'preview', 'main'].includes(sourceBranch)) throw new Error('--source-branch must be dev, preview, or main');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/u.test(workflow)) throw new Error('--workflow must be a workflow filename');
  const run = selectExactSuccessfulCiRun(fetchWorkflowRuns(repository, workflow, sourceBranch), { repository, sourceSha, sourceBranch });
  const output = { runId: Number(run.id), runUrl: String(run.html_url ?? ''), sourceSha, sourceBranch };
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) await appendFile(githubOutput, `ci_run_id=${output.runId}\nci_run_url=${output.runUrl}\n`, 'utf8');
  else process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
