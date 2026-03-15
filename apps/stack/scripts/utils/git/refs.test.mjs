import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGithubPullRequest } from './refs.mjs';

test('parseGithubPullRequest parses a PR number', () => {
  assert.deepEqual(parseGithubPullRequest('58'), { number: 58, owner: null, repo: null });
});

test('parseGithubPullRequest parses a GitHub PR URL', () => {
  assert.deepEqual(parseGithubPullRequest('https://github.com/happier-dev/happier/pull/58'), {
    number: 58,
    owner: 'happier-dev',
    repo: 'happier',
  });
});

test('parseGithubPullRequest parses an owner/repo#number PR ref', () => {
  assert.deepEqual(parseGithubPullRequest('happier-dev/happier#58'), {
    number: 58,
    owner: 'happier-dev',
    repo: 'happier',
  });
});

test('parseGithubPullRequest parses an owner/repo/pull/number PR ref', () => {
  assert.deepEqual(parseGithubPullRequest('happier-dev/happier/pull/77'), {
    number: 77,
    owner: 'happier-dev',
    repo: 'happier',
  });
});

test('parseGithubPullRequest returns null for invalid input', () => {
  assert.equal(parseGithubPullRequest('happier-dev/happier'), null);
  assert.equal(parseGithubPullRequest('happier-dev/happier#'), null);
});
