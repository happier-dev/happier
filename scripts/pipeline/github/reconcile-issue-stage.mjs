#!/usr/bin/env node

// @ts-check

import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const ISSUE_STAGES = Object.freeze([
  'stage:source',
  'stage:dev',
  'stage:preview',
  'stage:stable',
]);

const DEFAULT_API_BASE_URL = 'https://api.github.com';

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository '${repository}'. Expected owner/name.`);
  }
}

function assertStage(stage) {
  if (!ISSUE_STAGES.includes(stage)) {
    throw new Error(`'${stage}' is not a recognized issue stage.`);
  }
}

function assertForwardTransition(fromStage, toStage) {
  assertStage(fromStage);
  assertStage(toStage);
  const fromIndex = ISSUE_STAGES.indexOf(fromStage);
  const toIndex = ISSUE_STAGES.indexOf(toStage);
  if (toIndex <= fromIndex) {
    throw new Error(`Expected a forward stage transition, got '${fromStage}' -> '${toStage}'.`);
  }
}

function requestHeaders(token) {
  if (!token) throw new Error('A GitHub token is required.');
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'happier-issue-stage-reconciler',
    'x-github-api-version': '2022-11-28',
  };
}

function nextLink(response) {
  const raw = response.headers.get('link');
  if (!raw) return null;
  for (const part of raw.split(',')) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (match?.[2] === 'next') return match[1];
  }
  return null;
}

async function requestJson({ fetchImpl, url, token, method = 'GET', body }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...requestHeaders(token),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${method} ${url} failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  if (response.status === 204) return { value: null, response };
  return { value: await response.json(), response };
}

async function listPaginated({ fetchImpl, initialUrl, token }) {
  const values = [];
  let url = initialUrl;
  while (url) {
    const { value, response } = await requestJson({ fetchImpl, url, token });
    if (!Array.isArray(value)) throw new Error(`GitHub API returned a non-array collection for ${url}.`);
    values.push(...value);
    url = nextLink(response);
  }
  return values;
}

export async function snapshotOpenIssueNumbers({
  repository,
  fromStage,
  token,
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
}) {
  assertRepository(repository);
  assertStage(fromStage);
  const query = new URLSearchParams({
    state: 'open',
    labels: fromStage,
    per_page: '100',
  });
  const values = await listPaginated({
    fetchImpl,
    initialUrl: `${apiBaseUrl}/repos/${repository}/issues?${query}`,
    token,
  });
  return values
    .filter((issue) => issue && typeof issue.number === 'number' && !issue.pull_request)
    .map((issue) => issue.number);
}

async function assertRepositoryLabelsExist({ repository, stages, token, fetchImpl, apiBaseUrl }) {
  const labels = await listPaginated({
    fetchImpl,
    initialUrl: `${apiBaseUrl}/repos/${repository}/labels?per_page=100`,
    token,
  });
  const names = new Set(labels.map((label) => label?.name).filter((name) => typeof name === 'string'));
  const missing = stages.filter((stage) => !names.has(stage));
  if (missing.length > 0) {
    throw new Error(`Repository is missing required issue stage label(s): ${missing.join(', ')}.`);
  }
}

export async function advanceIssueStage({
  repository,
  issueNumbers,
  fromStage,
  toStage,
  token,
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
}) {
  assertRepository(repository);
  assertForwardTransition(fromStage, toStage);
  if (!Array.isArray(issueNumbers) || issueNumbers.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('Issue numbers must be an array of positive integers.');
  }
  const uniqueIssueNumbers = [...new Set(issueNumbers)];
  if (uniqueIssueNumbers.length === 0) return [];
  await assertRepositoryLabelsExist({
    repository,
    stages: [fromStage, toStage],
    token,
    fetchImpl,
    apiBaseUrl,
  });

  const results = [];
  for (const issueNumber of uniqueIssueNumbers) {
    const issueUrl = `${apiBaseUrl}/repos/${repository}/issues/${issueNumber}`;
    const { value: issue } = await requestJson({ fetchImpl, url: issueUrl, token });
    if (issue?.pull_request) {
      results.push({ issueNumber, status: 'skipped_pull_request' });
      continue;
    }
    if (issue?.state !== 'open') {
      results.push({ issueNumber, status: 'skipped_closed' });
      continue;
    }

    const labelNames = new Set(
      Array.isArray(issue?.labels)
        ? issue.labels.map((label) => typeof label === 'string' ? label : label?.name).filter((name) => typeof name === 'string')
        : [],
    );
    if (!labelNames.has(fromStage)) {
      results.push({ issueNumber, status: labelNames.has(toStage) ? 'already_advanced' : 'skipped_stage_changed' });
      continue;
    }
    const conflictingStage = ISSUE_STAGES.find(
      (stage) => stage !== fromStage && stage !== toStage && labelNames.has(stage),
    );
    if (conflictingStage) {
      results.push({ issueNumber, status: 'skipped_stage_changed' });
      continue;
    }

    if (!labelNames.has(toStage)) {
      await requestJson({
        fetchImpl,
        url: `${issueUrl}/labels`,
        token,
        method: 'POST',
        body: { labels: [toStage] },
      });
    }
    await requestJson({
      fetchImpl,
      url: `${issueUrl}/labels/${encodeURIComponent(fromStage)}`,
      token,
      method: 'DELETE',
    });
    results.push({ issueNumber, status: 'advanced' });
  }
  return results;
}

async function writeGithubOutput(path, values) {
  if (!path) return;
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  await appendFile(path, body, 'utf8');
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      'from-stage': { type: 'string' },
      'to-stage': { type: 'string' },
      'issues-json': { type: 'string', default: '[]' },
      'github-output': { type: 'string', default: '' },
    },
  });
  const operation = positionals[0];
  const repository = String(values.repo ?? '').trim();
  const fromStage = String(values['from-stage'] ?? '').trim();
  const token = String(process.env.GITHUB_TOKEN ?? '').trim();

  if (operation === 'snapshot') {
    const issues = await snapshotOpenIssueNumbers({ repository, fromStage, token });
    const issuesJson = JSON.stringify(issues);
    await writeGithubOutput(String(values['github-output'] ?? '').trim(), {
      issues_json: issuesJson,
      issue_count: String(issues.length),
    });
    process.stdout.write(`${issuesJson}\n`);
    return;
  }
  if (operation === 'advance') {
    const toStage = String(values['to-stage'] ?? '').trim();
    let issueNumbers;
    try {
      issueNumbers = JSON.parse(String(values['issues-json'] ?? '[]'));
    } catch {
      throw new Error('--issues-json must be valid JSON.');
    }
    const results = await advanceIssueStage({ repository, issueNumbers, fromStage, toStage, token });
    process.stdout.write(`${JSON.stringify(results)}\n`);
    return;
  }
  throw new Error("Expected operation 'snapshot' or 'advance'.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
