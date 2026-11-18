import { spawnSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const commitSha = /^[0-9a-f]{40}$/u;

async function ghApiCli(path) {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh api ${path.split('?')[0]} failed`);
  return JSON.parse(result.stdout);
}

/**
 * The tree a gate run selects changes against. A pull request diffs against its
 * base. A push diffs against the newest earlier push run of this workflow that
 * started: GitHub cancels a replaced pending run before it creates any job, so
 * `github.event.before` alone would never select the replaced pushes' commits.
 * An empty result means "no usable baseline": callers select the whole tree.
 * @param {{repoRoot?: string; eventName: string; pullRequestBaseSha?: string; repository?: string;
 *   branch?: string; runId?: string; headSha: string;
 *   ghApi?: (path: string) => Promise<any>; log?: (line: string) => void}} input
 */
export async function resolveGateBaseSha({ repoRoot = process.cwd(), eventName, pullRequestBaseSha = '',
  repository = '', branch = '', runId = '', headSha, ghApi = ghApiCli, log = () => {} }) {
  if (eventName === 'pull_request') return pullRequestBaseSha;
  if (eventName !== 'push') return '';
  const listing = await ghApi(`repos/${repository}/actions/workflows/tests.yml/runs?event=push&branch=${encodeURIComponent(branch)}&per_page=100`);
  const earlier = (listing.workflow_runs ?? [])
    .filter(run => Number(run.id) < Number(runId) && commitSha.test(String(run.head_sha)) && run.head_sha !== headSha)
    .sort((a, b) => Number(b.id) - Number(a.id));
  for (const run of earlier) {
    const jobs = await ghApi(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=1`);
    if (!(Number(jobs.total_count) > 0)) continue;
    const present = spawnSync('git', ['cat-file', '-e', `${run.head_sha}^{commit}`], { cwd: repoRoot }).status === 0;
    if (!present) {
      log(`Baseline run ${run.id} commit ${run.head_sha} is not in this clone; selecting the whole tree.`);
      return '';
    }
    log(`Baseline: run ${run.id} (${run.head_sha}), the newest earlier push run that started.`);
    return run.head_sha;
  }
  log('No earlier started push run in the listing; selecting the whole tree.');
  return '';
}

async function main() {
  let base = '';
  try {
    base = await resolveGateBaseSha({
      eventName: String(process.env.GITHUB_EVENT_NAME ?? ''),
      pullRequestBaseSha: String(process.env.PR_BASE_SHA ?? ''),
      repository: String(process.env.GITHUB_REPOSITORY ?? ''),
      branch: String(process.env.GITHUB_REF_NAME ?? ''),
      runId: String(process.env.GITHUB_RUN_ID ?? ''),
      headSha: String(process.env.GITHUB_SHA ?? ''),
      log: line => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    // Unknown baseline widens the run; the annotation keeps the widening visible.
    process.stdout.write(`::warning title=Gate baseline unavailable::${error instanceof Error ? error.message : String(error)}; selecting the whole tree.\n`);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `base_sha=${base}\n`);
  process.stdout.write(`${base}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
