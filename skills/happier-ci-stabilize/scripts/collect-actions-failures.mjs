#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

function fail(message) {
  process.stderr.write(`[collect-actions-failures] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = { repo: '', runId: '', attempt: '', out: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--repo', '--run-id', '--attempt', '--out'].includes(key) || value === undefined) {
      fail('Usage: collect-actions-failures.mjs --repo <owner/repo> --run-id <id> [--attempt <n>] [--out <absolute-dir>]');
    }
    index += 1;
    if (key === '--repo') values.repo = value;
    if (key === '--run-id') values.runId = value;
    if (key === '--attempt') values.attempt = value;
    if (key === '--out') values.out = value;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values.repo)) fail('--repo must be owner/repo');
  if (!/^[1-9][0-9]*$/u.test(values.runId)) fail('--run-id must be a positive integer');
  if (values.attempt && !/^[1-9][0-9]*$/u.test(values.attempt)) fail('--attempt must be a positive integer');
  if (values.out && !values.out.startsWith('/')) fail('--out must be an absolute path');
  return values;
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function ghJson(endpoint) {
  const waits = [0, 2_000, 5_000, 10_000];
  let lastError = '';
  for (const waitMs of waits) {
    if (waitMs > 0) await delay(waitMs);
    const result = spawnSync('gh', ['api', endpoint], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch (error) {
        fail(`GitHub returned invalid JSON for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    lastError = String(result.stderr || result.error?.message || `exit ${result.status}`).trim();
  }
  fail(`GitHub read failed after retries for ${endpoint}: ${lastError}`);
}

async function downloadJobLog({ endpoint, destination }) {
  const waits = [0, 2_000, 5_000, 10_000];
  let lastError = '';
  for (const waitMs of waits) {
    if (waitMs > 0) await delay(waitMs);
    const output = await open(destination, 'w');
    let stderr = '';
    let exitCode;
    try {
      const child = spawn('gh', ['api', endpoint], { stdio: ['ignore', output.fd, 'pipe'] });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      exitCode = await new Promise((resolveExit) => child.on('close', resolveExit));
    } finally {
      await output.close();
    }
    if (exitCode === 0) return;
    lastError = stderr.trim() || `exit ${exitCode}`;
  }
  fail(`Failed to download ${endpoint}: ${lastError}`);
}

async function collectExcerpt(path) {
  const matches = [];
  const patterns = [
    /##\[error\]/u,
    /\bnot ok\b/u,
    /AssertionError/u,
    /Process completed with exit code/u,
    /One or more .* failed/u,
    /(^|\s)(Error|FAIL)(:|\s)/u,
  ];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) matches.push(line.slice(0, 2_000));
    if (matches.length >= 200) break;
  }
  return matches;
}

const args = parseArgs(process.argv.slice(2));
const run = await ghJson(`repos/${args.repo}/actions/runs/${args.runId}`);
const attempt = args.attempt || String(run.run_attempt ?? '1');
const jobsEndpointBase = args.attempt
  ? `repos/${args.repo}/actions/runs/${args.runId}/attempts/${attempt}/jobs`
  : `repos/${args.repo}/actions/runs/${args.runId}/jobs`;

const jobs = [];
for (let page = 1; ; page += 1) {
  const response = await ghJson(`${jobsEndpointBase}?per_page=100&page=${page}`);
  const pageJobs = Array.isArray(response.jobs) ? response.jobs : [];
  jobs.push(...pageJobs);
  if (pageJobs.length < 100) break;
}

const outDir = resolve(args.out || `/tmp/happier-ci-run-${args.runId}-attempt-${attempt}`);
const jobsDir = resolve(outDir, 'jobs');
await mkdir(jobsDir, { recursive: true });

const failureConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
const failedJobs = jobs.filter((job) => failureConclusions.has(job.conclusion));
const failedEvidence = [];
for (const job of failedJobs) {
  const logPath = resolve(jobsDir, `${job.id}.log`);
  await downloadJobLog({ endpoint: `repos/${args.repo}/actions/jobs/${job.id}/logs`, destination: logPath });
  failedEvidence.push({
    id: job.id,
    name: job.name,
    conclusion: job.conclusion,
    url: job.html_url,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    failedSteps: (job.steps ?? [])
      .filter((step) => failureConclusions.has(step.conclusion))
      .map((step) => ({ number: step.number, name: step.name, conclusion: step.conclusion })),
    logPath,
    excerpt: await collectExcerpt(logPath),
  });
}

const conclusionCounts = {};
for (const job of jobs) {
  const key = job.conclusion || job.status || 'unknown';
  conclusionCounts[key] = (conclusionCounts[key] ?? 0) + 1;
}

const summary = {
  schemaVersion: 1,
  repository: args.repo,
  run: {
    id: Number(args.runId), attempt: Number(attempt), workflow: run.name, event: run.event,
    status: run.status, conclusion: run.conclusion, headSha: run.head_sha, headBranch: run.head_branch,
    url: run.html_url, createdAt: run.created_at, updatedAt: run.updated_at,
  },
  collectionComplete: run.status === 'completed' && jobs.every((job) => job.status === 'completed'),
  totalJobs: jobs.length,
  conclusionCounts,
  activeJobs: jobs.filter((job) => job.status !== 'completed')
    .map((job) => ({ id: job.id, name: job.name, status: job.status, url: job.html_url })),
  failedJobs: failedEvidence,
};

const summaryPath = resolve(outDir, 'summary.json');
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ ...summary, summaryPath }, null, 2)}\n`);
