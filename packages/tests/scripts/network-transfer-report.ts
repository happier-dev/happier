import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { findNetworkTransferBaseline, type NetworkBaselineRun } from '../src/testkit/uiE2e/networkTransferBaseline';
import { compareNetworkTransfer, MAX_NETWORK_REPORT_BYTES, parseNetworkTransferReport, type NetworkTransferReport } from '../src/testkit/uiE2e/networkTransferReport';

const exec = promisify(execFile);
const runSchema = z.object({ id: z.number().int().positive(), path: z.string(), head_branch: z.string(), head_sha: z.string().regex(/^[a-f0-9]{40}$/), event: z.string(), conclusion: z.string().nullable(), head_repository: z.object({ full_name: z.string() }) });
const artifactSchema = z.object({ id: z.number().int().positive(), name: z.string(), expired: z.boolean(), created_at: z.string(), workflow_run: z.object({ id: z.number().int().positive(), head_branch: z.string() }) });

async function reportsIn(directory: string): Promise<NetworkTransferReport[]> {
  const results: NetworkTransferReport[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await reportsIn(file));
    else if (/^network-transfer\.retry-\d+\.json$/.test(entry.name)) {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size > MAX_NETWORK_REPORT_BYTES) throw new Error('invalid network report file type or size');
      results.push(parseNetworkTransferReport(await readFile(file, 'utf8')));
    } else if (!entry.isFile()) throw new Error('network artifact contains a non-regular entry');
  }
  return results.sort((a, b) => a.repeatEachIndex - b.repeatEachIndex || a.retry - b.retry);
}

async function main() {
  const current = await reportsIn(resolve('.project/logs/e2e/ui-playwright'));
  if (current.length === 0) throw new Error('current network measurement missing');
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const branch = process.env.NETWORK_TRANSFER_BASE_BRANCH ?? 'dev';
  const warnings: string[] = [];
  let failed = false;
  const markdown: string[] = ['## Network transfer comparison\n', `Ceilings: ${process.env.NETWORK_TRANSFER_ENFORCE === 'true' ? 'enforced' : 'report only'}. Every retry is reported; a failed first attempt remains a failure.\n`];
  const gh = async (args: string[]) => (await exec('gh', args, { encoding: 'utf8' })).stdout;
  const api = async (path: string) => JSON.parse(await gh(['api', '-H', 'X-GitHub-Api-Version: 2026-03-10', path])) as unknown;
  const reader = {
    async runs(page: number): Promise<NetworkBaselineRun[]> {
      // Start from named artifacts: old successful CI without this workload needs
      // no downloads. GitHub's artifacts endpoint pages newest-first (100/page).
      const data = z.object({ artifacts: z.array(artifactSchema) }).parse(await api(`repos/${repository}/actions/artifacts?name=ui-e2e-network-transfer&per_page=100&page=${page}`));
      const runs = await Promise.all(data.artifacts.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(async (artifact) => {
        const run = runSchema.parse(await api(`repos/${repository}/actions/runs/${artifact.workflow_run.id}`));
        return { ...run, conclusion: artifact.expired || run.path !== '.github/workflows/tests.yml' ? 'unavailable' : run.conclusion ?? 'in_progress' };
      }));
      return runs;
    },
    async reports(run: NetworkBaselineRun) {
      const directory = await mkdtemp(join(tmpdir(), 'happier-network-base-'));
      try {
        // gh downloads only data from successful canonical push runs, never executes it.
        await gh(['run', 'download', String(run.id), '--repo', repository, '--name', 'ui-e2e-network-transfer', '--dir', directory]);
        return await reportsIn(directory);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
  let base: Awaited<ReturnType<typeof findNetworkTransferBaseline>>;
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) && process.env.GH_TOKEN && current[0].testStatus === 'passed') {
    try {
      base = await findNetworkTransferBaseline({ current: current[0], repository, branch, currentRun: process.env.GITHUB_RUN_ID, reader,
        warn(message) { warnings.push(message); } });
    } catch { warnings.push('Base discovery unavailable (Actions API/authentication); baseline is missing.'); }
  } else warnings.push('Base discovery unavailable (repository/read token missing); baseline is missing.');
  const runUrl = (id: string | number) => `https://github.com/${repository}/actions/runs/${id}`;
  if (base) markdown.push(`[Latest comparable successful base-branch push baseline](${runUrl(base.run.id)}) (SHA ${base.run.head_sha}); this is an observed baseline, not necessarily the PR base SHA.\n`);
  else markdown.push('Base: missing (no comparable successful push artifact).\n');
  if (process.env.GITHUB_RUN_ID) markdown.push(`[Current JSON artifacts](${runUrl(process.env.GITHUB_RUN_ID)}#artifacts).\n`);
  for (const report of current) {
    const comparison = compareNetworkTransfer(report, base?.report);
    failed ||= comparison.violations.length > 0;
    markdown.push(`### Repetition ${report.repeatEachIndex}, retry ${report.retry}\n`, comparison.markdown);
  }
  markdown.push(...warnings.map((w) => `\n${w}\n`));
  const output = markdown.join('\n');
  process.stdout.write(output);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, output);
  if (failed && process.env.NETWORK_TRANSFER_ENFORCE === 'true') process.exitCode = 1;
}

main().catch(async () => {
  // Do not render untrusted schema values or file contents into Actions summaries.
  process.stderr.write('Network comparison failed: current result missing or invalid.\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '\nNetwork comparison failed: current result missing or invalid.\n');
  process.exitCode = 1;
});
