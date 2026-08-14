#!/usr/bin/env node

// @ts-check

import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const CHANNEL_BRANCHES = Object.freeze({
  dev: 'dev',
  preview: 'preview',
  stable: 'main',
});

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value */
export function parseWorkflowRunPath(value) {
  // The broader release identity verifier only needs the workflow filename and
  // still consumes response shapes documented with an optional `@<ref>` suffix.
  // Candidate admission below deliberately requires the raw REST `path` value.
  const runPath = String(value ?? '');
  const refDelimiter = runPath.lastIndexOf('@');
  return {
    workflowPath: refDelimiter > 0 ? runPath.slice(0, refDelimiter) : runPath,
    workflowRef: refDelimiter > 0 ? runPath.slice(refDelimiter + 1) : '',
  };
}

/**
 * @param {unknown} run
 * @param {{
 *   repository: string;
 *   runId: number;
 *   expectedWorkflowPath: string;
 *   expectedHeadSha: string;
 *   expectedChannel: keyof typeof CHANNEL_BRANCHES;
 * }} expected
 */
export function validateCandidateRun(run, expected) {
  const record = asRecord(run);
  const repository = expected.repository.toLowerCase();
  if (record.id !== expected.runId) throw new Error('[release] candidate workflow run ID does not match');
  if (String(asRecord(record.repository).full_name ?? '').toLowerCase() !== repository) {
    throw new Error('[release] candidate workflow run repository does not match');
  }
  if (String(asRecord(record.head_repository).full_name ?? '').toLowerCase() !== repository) {
    throw new Error('[release] candidate workflow run head repository does not match');
  }
  if (record.path !== expected.expectedWorkflowPath) {
    throw new Error('[release] candidate workflow run used an untrusted workflow path');
  }
  const expectedBranch = CHANNEL_BRANCHES[expected.expectedChannel];
  if (!expectedBranch) {
    throw new Error('[release] candidate channel is invalid');
  }
  if (record.head_branch !== expectedBranch) {
    throw new Error('[release] candidate head branch does not match the requested channel');
  }
  if (record.event !== 'workflow_dispatch') {
    throw new Error('[release] candidate workflow run must be a direct workflow_dispatch');
  }
  if (record.status !== 'completed' || record.conclusion !== 'success') {
    throw new Error('[release] candidate workflow run is not a successful completed run');
  }
  if (String(record.head_sha ?? '').toLowerCase() !== expected.expectedHeadSha.toLowerCase()) {
    throw new Error('[release] candidate workflow run head SHA does not match');
  }
}

/**
 * @param {unknown[]} artifacts
 * @param {{ artifactName: string; runId: number; expectedHeadSha: string }} expected
 */
export function selectCandidateArtifact(artifacts, expected) {
  const matching = artifacts
    .map(asRecord)
    .filter((artifact) => artifact.name === expected.artifactName);
  if (matching.length !== 1) {
    throw new Error('[release] expected exactly one candidate artifact in the admitted workflow run');
  }
  const artifact = matching[0];
  if (artifact.expired === true) throw new Error('[release] candidate artifact has expired');
  const workflowRun = asRecord(artifact.workflow_run);
  if (workflowRun.id !== expected.runId) {
    throw new Error('[release] candidate artifact workflow run does not match');
  }
  if (
    String(workflowRun.head_sha ?? '').toLowerCase()
    !== expected.expectedHeadSha.toLowerCase()
  ) {
    throw new Error('[release] candidate artifact head SHA does not match');
  }
  const artifactId = typeof artifact.id === 'number' ? artifact.id : Number.NaN;
  if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
    throw new Error('[release] candidate artifact ID is invalid');
  }
  return artifactId;
}

/** @param {string} url @param {string} token */
async function githubJson(url, token) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'happier-release-candidate-admission',
    },
  });
  if (!response.ok) {
    throw new Error(`[release] GitHub candidate provenance lookup failed (${response.status})`);
  }
  return response.json();
}

/**
 * @param {string} baseUrl
 * @param {string} repository
 * @param {number} runId
 * @param {string} token
 * @returns {Promise<unknown[]>}
 */
async function listRunArtifacts(baseUrl, repository, runId, token) {
  const artifacts = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = asRecord(await githubJson(
      `${baseUrl}/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      token,
    ));
    const entries = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    artifacts.push(...entries);
    const totalCount = Number(payload.total_count ?? artifacts.length);
    if (artifacts.length >= totalCount || entries.length === 0) return artifacts;
  }
  throw new Error('[release] candidate artifact listing exceeded the pagination limit');
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repository: { type: 'string' },
      'run-id': { type: 'string' },
      'expected-workflow-path': { type: 'string' },
      'expected-head-sha': { type: 'string' },
      channel: { type: 'string' },
      'artifact-name': { type: 'string' },
      'github-output': { type: 'string', default: '' },
      'api-base-url': { type: 'string', default: 'https://api.github.com' },
    },
    allowPositionals: false,
  });
  const repository = String(values.repository ?? '').trim();
  const runIdText = String(values['run-id'] ?? '').trim();
  const expectedWorkflowPath = String(values['expected-workflow-path'] ?? '').trim();
  const expectedHeadSha = String(values['expected-head-sha'] ?? '').trim().toLowerCase();
  const channel = String(values.channel ?? '').trim();
  const artifactName = String(values['artifact-name'] ?? '').trim();
  const token = String(process.env.GITHUB_TOKEN ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('[release] --repository must be owner/repo');
  if (!/^[0-9]+$/.test(runIdText)) throw new Error('[release] --run-id must contain decimal digits');
  if (!expectedWorkflowPath) throw new Error('[release] --expected-workflow-path is required');
  if (!/^[a-f0-9]{40}$/.test(expectedHeadSha)) throw new Error('[release] --expected-head-sha must be a full commit ID');
  if (!Object.hasOwn(CHANNEL_BRANCHES, channel)) {
    throw new Error('[release] --channel must be dev, preview, or stable');
  }
  if (!artifactName) throw new Error('[release] --artifact-name is required');
  if (!token) throw new Error('[release] GITHUB_TOKEN is required for candidate provenance admission');

  const runId = Number(runIdText);
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('[release] --run-id is outside the safe integer range');
  const baseUrl = String(values['api-base-url'] ?? '').replace(/\/+$/u, '');
  const run = await githubJson(`${baseUrl}/repos/${repository}/actions/runs/${runId}`, token);
  validateCandidateRun(run, {
    repository,
    runId,
    expectedWorkflowPath,
    expectedHeadSha,
    expectedChannel: /** @type {keyof typeof CHANNEL_BRANCHES} */ (channel),
  });
  const artifacts = await listRunArtifacts(baseUrl, repository, runId, token);
  const artifactId = selectCandidateArtifact(artifacts, { artifactName, runId, expectedHeadSha });
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) await appendFile(githubOutput, `artifact_id=${artifactId}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, runId, artifactId, artifactName }, null, 2));
  return { runId, artifactId, artifactName };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
