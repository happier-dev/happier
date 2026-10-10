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

async function listPaginated({ fetchImpl, initialUrl, token, collectionKey, validate }) {
  const values = [];
  let url = initialUrl;
  while (url) {
    const { value, response } = await requestJson({ fetchImpl, url, token });
    validate?.(value);
    const collection = collectionKey ? value?.[collectionKey] : value;
    if (!Array.isArray(collection)) throw new Error(`GitHub API returned a non-array collection for ${url}.`);
    values.push(...collection);
    url = nextLink(response);
  }
  return values;
}

function referencedIssueNumbers(commits, repository) {
  const referenced = new Set();
  for (const commit of commits) {
    if (typeof commit?.commit?.message !== 'string') throw new Error('Candidate ancestry returned a commit without its message.');
    for (const line of commit.commit.message.split(/\r?\n/)) {
      if (!/^\s*(?:refs?|fix(?:es|ed)?|clos(?:e[sd]?)|resolv(?:e[sd]?))\b:?\s+/i.test(line)) continue;
      for (const match of line.matchAll(/(?:(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/issues\/|#)|#)([1-9][0-9]*)/g)) {
        if (!match[1] || match[1].toLowerCase() === repository.toLowerCase()) referenced.add(Number(match[2]));
      }
    }
  }
  return referenced;
}

export async function snapshotOpenIssueNumbers({
  repository,
  fromStage,
  token,
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  candidateSha = '',
}) {
  assertRepository(repository);
  assertStage(fromStage);
  if (candidateSha && !/^[a-f0-9]{40}$/.test(candidateSha)) {
    throw new Error('Candidate issue snapshot requires a full commit SHA.');
  }
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
  const issueNumbers = values
    .filter((issue) => issue && typeof issue.number === 'number' && !issue.pull_request)
    .map((issue) => issue.number);
  // Current-dev nightlies retain their whole-queue contract. Pinned releases
  // need cumulative candidate ancestry: the target branch may already contain
  // a correction, including after a partially completed release is resumed.
  if (!candidateSha || issueNumbers.length === 0) return issueNumbers;
  // Bind source after reading the queue. A historical partial reference cannot
  // stand in for newer correction work on the queue's canonical source branch.
  const { value: dev } = await requestJson({
    fetchImpl, url: `${apiBaseUrl}/repos/${repository}/commits/dev`, token,
  });
  if (!/^[a-f0-9]{40}$/.test(dev?.sha)) throw new Error('Canonical dev source returned an invalid commit SHA.');
  const newerReferences = dev.sha === candidateSha ? new Set() : referencedIssueNumbers(await listPaginated({
    fetchImpl,
    initialUrl: `${apiBaseUrl}/repos/${repository}/compare/${candidateSha}...${dev.sha}?per_page=100`,
    token,
    collectionKey: 'commits',
    validate: (comparison) => {
      if (comparison?.status !== 'ahead' && comparison?.status !== 'identical') {
        throw new Error('Pinned candidate is not integrated in canonical dev ancestry.');
      }
    },
  }), repository);
  const commits = await listPaginated({
    fetchImpl,
    initialUrl: `${apiBaseUrl}/repos/${repository}/commits?sha=${candidateSha}&per_page=100`,
    token,
  });
  const referenced = referencedIssueNumbers(commits, repository);
  for (const number of newerReferences) referenced.delete(number);
  const unproven = issueNumbers.filter((number) => !referenced.has(number));
  if (unproven.length > 0) {
    console.error(`[issue-stage] Keeping ${fromStage} issues queued without current correction proof in candidate ${candidateSha} (missing candidate reference or newer dev work): ${unproven.map((number) => `#${number}`).join(', ')}. Verify their complete correction provenance before advancing them.`);
  }
  return issueNumbers.filter((number) => referenced.has(number));
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
      'candidate-sha': { type: 'string', default: '' },
    },
  });
  const operation = positionals[0];
  const repository = String(values.repo ?? '').trim();
  const fromStage = String(values['from-stage'] ?? '').trim();
  const token = String(process.env.GITHUB_TOKEN ?? '').trim();

  if (operation === 'snapshot') {
    const issues = await snapshotOpenIssueNumbers({
      repository, fromStage, token,
      candidateSha: String(values['candidate-sha'] ?? '').trim(),
    });
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
