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

function pullRequest(overrides = {}) {
  return { number: 267, state: 'open', draft: false, user: { login: 'author' }, head: { sha: 'current-head' }, ...overrides };
}

function planPullRequest(overrides = {}) {
  return planIssueNeedsHandoff({
    eventName: 'pull_request_target',
    action: 'opened',
    issue: issue(['type: bug'], { pull_request: {} }),
    pullRequest: pullRequest(),
    eventHeadSha: 'current-head',
    ...overrides,
  });
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

test('ready pull requests and current-head updates enter maintainer review while drafts do not', () => {
  for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize']) {
    assert.deepEqual(planPullRequest({ action, issue: issue(['needs:author', 'type: bug'], { pull_request: {} }) }), {
      status: 'planned', addLabels: ['needs:maintainer'], removeLabels: ['needs:author'],
    });
    assert.deepEqual(planPullRequest({ action, pullRequest: pullRequest({ draft: true }) }), {
      status: 'ignored_draft', addLabels: [], removeLabels: [],
    });
  }
  assert.deepEqual(planPullRequest({ action: 'synchronize', eventHeadSha: 'old-head' }), {
    status: 'ignored_stale_head', addLabels: [], removeLabels: [],
  });
});

test('only an author reply wakes a pull request waiting for its author, including repository members', () => {
  const waiting = { eventName: 'issue_comment', action: 'created',
    issue: issue(['needs:author', 'priority:p1'], { pull_request: {} }) };
  for (const commenterPermission of ['none', 'write']) {
    assert.deepEqual(planPullRequest({ ...waiting, commenterPermission,
      comment: { body: 'Here is the requested explanation.', user: { login: 'author', type: 'User' } } }), {
      status: 'planned', addLabels: ['needs:maintainer'], removeLabels: ['needs:author'],
    });
  }
  for (const user of [{ login: 'other', type: 'User' }, { login: 'author', type: 'Bot' }]) {
    const result = planPullRequest({ ...waiting, comment: { body: 'Unrelated update', user } });
    assert.deepEqual(result.addLabels, []);
    assert.deepEqual(result.removeLabels, []);
  }
  assert.deepEqual(planPullRequest({ ...waiting, issue: issue([], { pull_request: {} }),
    comment: { body: 'An unsolicited reply.', user: { login: 'author', type: 'User' } } }), {
    status: 'no_change', addLabels: [], removeLabels: [],
  });
});

test('explicit PR handoffs share directive authority and reject the wrong participant label', () => {
  const handoff = { eventName: 'issue_comment', action: 'created', commenterPermission: 'maintain',
    issue: issue(['needs:maintainer', 'roadmap'], { pull_request: {} }),
    comment: { body: '<!-- happier-label:add=needs:author -->\n<!-- happier-label:remove=needs:maintainer -->',
      user: { login: 'maintainer', type: 'User' } } };
  assert.deepEqual(planPullRequest(handoff), {
    status: 'planned', addLabels: ['needs:author'], removeLabels: ['needs:maintainer'],
  });
  const foreignDirective = planPullRequest({ ...handoff, commenterPermission: 'none' });
  assert.deepEqual(foreignDirective.addLabels, []);
  assert.deepEqual(foreignDirective.removeLabels, []);
  assert.throws(() => planPullRequest({ ...handoff,
    comment: { ...handoff.comment, body: '<!-- happier-label:add=needs:reporter -->' } }), /needs:reporter.*issues/);
  assert.throws(() => planIssueNeedsHandoff({ ...handoff, issue: issue([]) }), /needs:author.*pull requests/);
  assert.throws(() => planPullRequest({ ...handoff,
    comment: { ...handoff.comment, body: '<!-- happier-label:add=needs:author -->' } }), /needs labels/);
});

test('closed and merged pull requests release handoffs even when an old open event arrives late', () => {
  for (const labels of [['needs:author', 'type: bug'], ['needs:maintainer'], ['needs:reporter']]) {
    assert.deepEqual(planPullRequest({ action: 'closed', issue: issue(labels, { state: 'closed', pull_request: {} }),
      pullRequest: pullRequest({ state: 'closed' }) }), {
      status: 'planned', addLabels: [], removeLabels: labels.filter(label => label.startsWith('needs:')),
    });
  }
  assert.deepEqual(planPullRequest({ action: 'closed' }), {
    status: 'ignored_event', addLabels: [], removeLabels: [],
  });
});

test('PR lifecycle reconciliation reads live PR authority and changes only handoff labels', async () => {
  const mutations = [];
  const result = await reconcileIssueNeeds({
    repository: 'happier-dev/happier', eventName: 'pull_request_target', token: 'test-token',
    event: { action: 'synchronize', pull_request: pullRequest() }, apiBaseUrl: 'https://api.github.test',
    fetchImpl: async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (!init.method || init.method === 'GET') {
        if (path.endsWith('/issues/267')) return jsonResponse(issue(['needs:author', 'roadmap'], { pull_request: {} }));
        if (path.endsWith('/pulls/267')) return jsonResponse(pullRequest());
        if (path.endsWith('/labels')) return jsonResponse([{ name: 'needs:maintainer' }, { name: 'needs:author' }]);
      }
      mutations.push({ path, method: init.method, body: init.body && JSON.parse(init.body) });
      if (init.method === 'POST') return jsonResponse([]);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${url}`);
    },
  });
  assert.deepEqual(result, { status: 'applied', issueNumber: 267,
    addedLabels: ['needs:maintainer'], removedLabels: ['needs:author'] });
  assert.deepEqual(mutations, [
    { path: '/repos/happier-dev/happier/issues/267/labels', method: 'POST', body: { labels: ['needs:maintainer'] } },
    { path: '/repos/happier-dev/happier/issues/267/labels/needs%3Aauthor', method: 'DELETE', body: undefined },
  ]);
});
