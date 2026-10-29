#!/usr/bin/env node

// @ts-check

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const ISSUE_NEEDS_LABELS = Object.freeze([
  'needs:maintainer',
  'needs:reporter',
]);

export const PULL_REQUEST_NEEDS_LABELS = Object.freeze([
  'needs:maintainer',
  'needs:author',
]);

const HANDOFF_LABELS = [...new Set([...ISSUE_NEEDS_LABELS, ...PULL_REQUEST_NEEDS_LABELS])];

export const SAVED_REPLY_LABELS = Object.freeze([
  ...HANDOFF_LABELS,
  'type: bug',
  'type: feature',
  'type: task',
  'priority:p0',
  'priority:p1',
  'priority:p2',
  'priority:p3',
]);

const PROJECT_PERMISSIONS = new Set(['admin', 'maintain', 'write', 'triage']);
const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DIRECTIVE_PREFIX = 'happier-label:';
const DIRECTIVE_PATTERN = /^<!-- happier-label:(add|remove)=([^<>\r\n]+) -->$/;

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository '${repository}'. Expected owner/name.`);
  }
}

function issueLabelNames(issue) {
  return new Set(
    Array.isArray(issue?.labels)
      ? issue.labels
          .map((label) => typeof label === 'string' ? label : label?.name)
          .filter((name) => typeof name === 'string')
      : [],
  );
}

function emptyPlan(status) {
  return { status, addLabels: [], removeLabels: [] };
}

function normalizePlan({ currentLabels, addLabels, removeLabels }) {
  const additions = [...new Set(addLabels)];
  const removals = [...new Set(removeLabels)];
  const contradictory = additions.find((label) => removals.includes(label));
  if (contradictory) {
    throw new Error(`Label '${contradictory}' cannot be present in both add and remove directives.`);
  }

  const resultingLabels = new Set(currentLabels);
  for (const label of removals) resultingLabels.delete(label);
  for (const label of additions) resultingLabels.add(label);
  if (HANDOFF_LABELS.filter((label) => resultingLabels.has(label)).length > 1) {
    throw new Error("An issue or pull request cannot have both needs labels; remove the current needs label in the same saved reply.");
  }

  const deltaAdditions = additions.filter((label) => !currentLabels.has(label));
  const deltaRemovals = removals.filter((label) => currentLabels.has(label));
  return {
    status: deltaAdditions.length > 0 || deltaRemovals.length > 0 ? 'planned' : 'no_change',
    addLabels: deltaAdditions,
    removeLabels: deltaRemovals,
  };
}

export function parseIssueLabelDirectives(body) {
  const addLabels = [];
  const removeLabels = [];
  for (const rawLine of String(body ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(DIRECTIVE_PATTERN);
    if (!match) {
      if (line.includes(DIRECTIVE_PREFIX)) {
        throw new Error(
          "A happier label command must be an exact standalone directive such as '<!-- happier-label:add=needs:reporter -->'.",
        );
      }
      continue;
    }
    const operation = match[1];
    const label = match[2];
    if (!SAVED_REPLY_LABELS.includes(label)) {
      throw new Error(`Saved-reply mutation of label '${label}' is not allowed.`);
    }
    (operation === 'add' ? addLabels : removeLabels).push(label);
  }
  return {
    addLabels: [...new Set(addLabels)],
    removeLabels: [...new Set(removeLabels)],
  };
}

export function planIssueNeedsHandoff({
  eventName,
  action,
  issue,
  pullRequest,
  eventHeadSha,
  comment,
  commenterPermission = 'none',
}) {
  const isPullRequest = Boolean(issue?.pull_request);
  if (isPullRequest && (!pullRequest || pullRequest.number !== issue.number)) {
    throw new Error('A matching live pull request is required for PR handoff.');
  }
  const currentLabels = issueLabelNames(issue);
  if (isPullRequest && pullRequest.state === 'closed') {
    return normalizePlan({ currentLabels, addLabels: [], removeLabels: HANDOFF_LABELS });
  }
  if ((isPullRequest ? pullRequest.state : issue?.state) !== 'open') return emptyPlan('ignored_closed');

  if (isPullRequest && eventName === 'pull_request_target'
      && ['opened', 'reopened', 'ready_for_review', 'synchronize'].includes(action)) {
    if (pullRequest.draft) return emptyPlan('ignored_draft');
    if (action === 'synchronize' && eventHeadSha !== pullRequest.head?.sha) {
      return emptyPlan('ignored_stale_head');
    }
    return normalizePlan({
      currentLabels,
      addLabels: ['needs:maintainer'],
      removeLabels: HANDOFF_LABELS.filter((label) => label !== 'needs:maintainer'),
    });
  }

  if (!isPullRequest && eventName === 'issues' && (action === 'opened' || action === 'reopened')) {
    return normalizePlan({
      currentLabels,
      addLabels: ['needs:maintainer'],
      removeLabels: ['needs:reporter'],
    });
  }

  if (eventName !== 'issue_comment' || action !== 'created') {
    return emptyPlan('ignored_event');
  }
  if (comment?.user?.type !== 'User') return emptyPlan('ignored_actor');

  if (PROJECT_PERMISSIONS.has(commenterPermission)) {
    const directives = parseIssueLabelDirectives(comment?.body);
    const wrongParticipant = isPullRequest ? 'needs:reporter' : 'needs:author';
    if (directives.addLabels.includes(wrongParticipant)) {
      throw new Error(`${wrongParticipant} is only valid on ${isPullRequest ? 'issues' : 'pull requests'}.`);
    }
    if (directives.addLabels.length > 0 || directives.removeLabels.length > 0) {
      return normalizePlan({ currentLabels, ...directives });
    }
    if (!isPullRequest) return emptyPlan('no_change');
  }

  const participantLabel = isPullRequest ? 'needs:author' : 'needs:reporter';
  if (!currentLabels.has(participantLabel)) return emptyPlan('no_change');
  if (isPullRequest && comment?.user?.login !== pullRequest.user?.login) {
    return emptyPlan('no_change');
  }

  return normalizePlan({
    currentLabels,
    addLabels: ['needs:maintainer'],
    removeLabels: [participantLabel],
  });
}

function requestHeaders(token) {
  if (!token) throw new Error('A GitHub token is required.');
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'happier-issue-needs-reconciler',
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

async function requestJson({ fetchImpl, url, token, method = 'GET', body, allowNotFound = false }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...requestHeaders(token),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (allowNotFound && response.status === 404) return { value: null, response };
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

async function getCommenterPermission({ repository, login, token, fetchImpl, apiBaseUrl }) {
  const { value } = await requestJson({
    fetchImpl,
    url: `${apiBaseUrl}/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    token,
    allowNotFound: true,
  });
  return typeof value?.permission === 'string' ? value.permission : 'none';
}

async function assertLabelsExist({ repository, labels, token, fetchImpl, apiBaseUrl }) {
  if (labels.length === 0) return;
  const values = await listPaginated({
    fetchImpl,
    initialUrl: `${apiBaseUrl}/repos/${repository}/labels?per_page=100`,
    token,
  });
  const available = new Set(values.map((label) => label?.name).filter((name) => typeof name === 'string'));
  const missing = labels.filter((label) => !available.has(label));
  if (missing.length > 0) {
    throw new Error(`Repository is missing required issue label(s): ${missing.join(', ')}.`);
  }
}

export async function reconcileIssueNeeds({
  repository,
  eventName,
  event,
  token,
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_API_BASE_URL,
}) {
  assertRepository(repository);
  const issueNumber = event?.issue?.number ?? event?.pull_request?.number;
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('The GitHub event does not contain a valid issue number.');
  }

  const issueUrl = `${apiBaseUrl}/repos/${repository}/issues/${issueNumber}`;
  const { value: liveIssue } = await requestJson({ fetchImpl, url: issueUrl, token });
  const livePullRequest = liveIssue?.pull_request
    ? (await requestJson({ fetchImpl, url: `${apiBaseUrl}/repos/${repository}/pulls/${issueNumber}`, token })).value
    : null;
  let commenterPermission = 'none';
  if (eventName === 'issue_comment' && event?.comment?.user?.type === 'User') {
    const login = event.comment.user.login;
    if (typeof login !== 'string' || login.length === 0) {
      throw new Error('The issue comment event does not contain a valid commenter login.');
    }
    commenterPermission = await getCommenterPermission({
      repository,
      login,
      token,
      fetchImpl,
      apiBaseUrl,
    });
  }

  const plan = planIssueNeedsHandoff({
    eventName,
    action: event?.action,
    issue: liveIssue,
    pullRequest: livePullRequest,
    eventHeadSha: event?.pull_request?.head?.sha,
    comment: event?.comment,
    commenterPermission,
  });
  if (plan.status !== 'planned') {
    return { status: plan.status, issueNumber, addedLabels: [], removedLabels: [] };
  }

  await assertLabelsExist({
    repository,
    labels: [...plan.addLabels, ...plan.removeLabels],
    token,
    fetchImpl,
    apiBaseUrl,
  });

  for (const label of plan.addLabels) {
    await requestJson({
      fetchImpl,
      url: `${issueUrl}/labels`,
      token,
      method: 'POST',
      body: { labels: [label] },
    });
  }
  for (const label of plan.removeLabels) {
    await requestJson({
      fetchImpl,
      url: `${issueUrl}/labels/${encodeURIComponent(label)}`,
      token,
      method: 'DELETE',
      allowNotFound: true,
    });
  }

  return {
    status: 'applied',
    issueNumber,
    addedLabels: plan.addLabels,
    removedLabels: plan.removeLabels,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      'event-name': { type: 'string' },
      'event-path': { type: 'string' },
    },
  });
  const repository = String(values.repo ?? '').trim();
  const eventName = String(values['event-name'] ?? '').trim();
  const eventPath = String(values['event-path'] ?? '').trim();
  if (!eventPath) throw new Error('--event-path is required.');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const result = await reconcileIssueNeeds({
    repository,
    eventName,
    event,
    token: String(process.env.GITHUB_TOKEN ?? '').trim(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
