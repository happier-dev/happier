import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIssueLabelDirectives,
  planIssueNeedsHandoff,
  reconcileIssueNeeds,
} from './reconcile-issue-needs.mjs';

function issue(labels = [], overrides = {}) {
  return {
    number: 267,
    state: 'open',
    labels: labels.map((name) => ({ name })),
    ...overrides,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('saved-reply directives require exact standalone syntax and preserve multiple operations', () => {
  assert.deepEqual(
    parseIssueLabelDirectives([
      'Could you share the app version and exact reproduction sequence?',
      '',
      '<!-- happier-label:add=needs:reporter -->',
      '<!-- happier-label:remove=needs:maintainer -->',
    ].join('\n')),
    {
      addLabels: ['needs:reporter'],
      removeLabels: ['needs:maintainer'],
    },
  );

  assert.deepEqual(parseIssueLabelDirectives('ordinary comment'), {
    addLabels: [],
    removeLabels: [],
  });
  assert.throws(
    () => parseIssueLabelDirectives('text <!-- happier-label:add=needs:reporter -->'),
    /standalone directive/,
  );
});

test('new and reopened issues are handed to maintainers without disturbing unrelated labels', () => {
  assert.deepEqual(
    planIssueNeedsHandoff({
      eventName: 'issues',
      action: 'opened',
      issue: issue(['type: bug']),
    }),
    {
      status: 'planned',
      addLabels: ['needs:maintainer'],
      removeLabels: [],
    },
  );

  assert.deepEqual(
    planIssueNeedsHandoff({
      eventName: 'issues',
      action: 'reopened',
      issue: issue(['needs:reporter', 'stage:preview']),
    }),
    {
      status: 'planned',
      addLabels: ['needs:maintainer'],
      removeLabels: ['needs:reporter'],
    },
  );
});

test('an external human response wakes maintainers only from the reporter-waiting state', () => {
  assert.deepEqual(
    planIssueNeedsHandoff({
      eventName: 'issue_comment',
      action: 'created',
      issue: issue(['needs:reporter']),
      comment: { body: 'Here are the requested versions.', user: { type: 'User' } },
      commenterPermission: 'read',
    }),
    {
      status: 'planned',
      addLabels: ['needs:maintainer'],
      removeLabels: ['needs:reporter'],
    },
  );

  assert.deepEqual(
    planIssueNeedsHandoff({
      eventName: 'issue_comment',
      action: 'created',
      issue: issue(['stage:source']),
      comment: { body: 'A related observation.', user: { type: 'User' } },
      commenterPermission: 'none',
    }),
    { status: 'no_change', addLabels: [], removeLabels: [] },
  );
});

test('bots cannot wake maintainers and external users cannot execute hidden directives', () => {
  for (const testCase of [
    {
      comment: { body: 'Automated update', user: { type: 'Bot' } },
      commenterPermission: 'none',
    },
    {
      comment: { body: '<!-- happier-label:remove=needs:reporter -->', user: { type: 'User' } },
      commenterPermission: 'read',
    },
  ]) {
    assert.deepEqual(
      planIssueNeedsHandoff({
        eventName: 'issue_comment',
        action: 'created',
        issue: issue(['needs:reporter']),
        ...testCase,
      }),
      testCase.comment.user.type === 'Bot'
        ? { status: 'ignored_actor', addLabels: [], removeLabels: [] }
        : {
            status: 'planned',
            addLabels: ['needs:maintainer'],
            removeLabels: ['needs:reporter'],
          },
    );
  }
});

test('permissioned maintainers can use allowlisted labels without replacing the full label set', () => {
  assert.deepEqual(
    planIssueNeedsHandoff({
      eventName: 'issue_comment',
      action: 'created',
      issue: issue(['needs:maintainer', 'type: feature', 'roadmap']),
      comment: {
        body: [
          'Updated triage.',
          '<!-- happier-label:add=needs:reporter -->',
          '<!-- happier-label:remove=needs:maintainer -->',
          '<!-- happier-label:add=type: bug -->',
          '<!-- happier-label:remove=type: feature -->',
        ].join('\n'),
        user: { type: 'User' },
      },
      commenterPermission: 'triage',
    }),
    {
      status: 'planned',
      addLabels: ['needs:reporter', 'type: bug'],
      removeLabels: ['needs:maintainer', 'type: feature'],
    },
  );
});

test('directives fail closed for protected labels, contradictions, and invalid needs results', () => {
  const base = {
    eventName: 'issue_comment',
    action: 'created',
    commenterPermission: 'write',
    comment: { user: { type: 'User' } },
  };

  assert.throws(
    () => planIssueNeedsHandoff({
      ...base,
      issue: issue([]),
      comment: { ...base.comment, body: '<!-- happier-label:add=stage:preview -->' },
    }),
    /not allowed/,
  );
  assert.throws(
    () => planIssueNeedsHandoff({
      ...base,
      issue: issue([]),
      comment: {
        ...base.comment,
        body: [
          '<!-- happier-label:add=priority:p1 -->',
          '<!-- happier-label:remove=priority:p1 -->',
        ].join('\n'),
      },
    }),
    /both add and remove/,
  );
  assert.throws(
    () => planIssueNeedsHandoff({
      ...base,
      issue: issue(['needs:maintainer']),
      comment: { ...base.comment, body: '<!-- happier-label:add=needs:reporter -->' },
    }),
    /both needs labels/,
  );
});

test('reconciliation validates live labels and applies only the additive/removal delta', async () => {
  const requests = [];
  const event = {
    action: 'created',
    issue: issue(['needs:maintainer', 'type: feature', 'roadmap']),
    comment: {
      body: [
        'Could you send the missing details?',
        '<!-- happier-label:add=needs:reporter -->',
        '<!-- happier-label:remove=needs:maintainer -->',
      ].join('\n'),
      user: { login: 'maintainer', type: 'User' },
    },
  };

  const result = await reconcileIssueNeeds({
    repository: 'happier-dev/happier',
    eventName: 'issue_comment',
    event,
    token: 'test-token',
    apiBaseUrl: 'https://api.github.test',
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      requests.push({ pathname: parsed.pathname, method: init.method ?? 'GET', body: init.body });
      if (parsed.pathname.endsWith('/collaborators/maintainer/permission')) {
        return jsonResponse({ permission: 'maintain' });
      }
      if (parsed.pathname.endsWith('/issues/267') && (!init.method || init.method === 'GET')) {
        return jsonResponse(event.issue);
      }
      if (parsed.pathname.endsWith('/labels') && (!init.method || init.method === 'GET')) {
        return jsonResponse([
          { name: 'needs:maintainer' },
          { name: 'needs:reporter' },
          { name: 'type: feature' },
          { name: 'roadmap' },
        ]);
      }
      if (init.method === 'POST') return jsonResponse([]);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    },
  });

  assert.deepEqual(result, {
    status: 'applied',
    issueNumber: 267,
    addedLabels: ['needs:reporter'],
    removedLabels: ['needs:maintainer'],
  });
  assert.deepEqual(
    requests.filter(({ method }) => method === 'POST' || method === 'DELETE'),
    [
      {
        pathname: '/repos/happier-dev/happier/issues/267/labels',
        method: 'POST',
        body: JSON.stringify({ labels: ['needs:reporter'] }),
      },
      {
        pathname: '/repos/happier-dev/happier/issues/267/labels/needs%3Amaintainer',
        method: 'DELETE',
        body: undefined,
      },
    ],
  );
});

test('reconciliation rejects a requested label that does not exist in the repository', async () => {
  await assert.rejects(
    reconcileIssueNeeds({
      repository: 'happier-dev/happier',
      eventName: 'issues',
      event: { action: 'opened', issue: issue([]) },
      token: 'test-token',
      apiBaseUrl: 'https://api.github.test',
      fetchImpl: async (url, init = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/issues/267') && (!init.method || init.method === 'GET')) return jsonResponse(issue([]));
        if (parsed.pathname.endsWith('/labels') && (!init.method || init.method === 'GET')) return jsonResponse([]);
        throw new Error(`unexpected request ${url}`);
      },
    }),
    /missing required issue label.*needs:maintainer/,
  );
});
