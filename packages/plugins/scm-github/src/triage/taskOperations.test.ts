import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { TriageGetResultV1Schema, TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_ISSUE_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from './__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT, readRecordedJsonBody } from './testkit/githubTriage.test-support.js';

const route = 'octo-org/example-app';
const issueNumber = String(GITHUB_ISSUE_RESPONSE.number);
const localRef = { kindId: 'issue', collisionScope: `github:${GITHUB_REPOSITORY_RESPONSE.id}`, entryId: issueNumber };
const locator = { v: 1, routingToken: route };
const fixture = createTriageSourceV1Fixture();
const instance = {
  ...fixture.configuredInstance,
  instance: { ...fixture.configuredInstance.instance, source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } },
  binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
  configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: route } })! },
};

describe('registered GitHub task writes at the provider HTTP boundary', () => {
  it('creates once, edits with native membership deltas, transitions and returns strict fresh observations', async () => {
    let issue: Record<string, unknown> = { ...GITHUB_ISSUE_RESPONSE, repository_url: `https://api.github.com/repos/${route}`, html_url: `https://github.com/${route}/issues/${issueNumber}`, title: 'Before', body: 'Before body', assignees: [{ login: 'old-owner' }], labels: [{ name: 'old-label' }] };
    const transport = createStubGithubTransport({ respond: (request) => {
      const pathname = new URL(request.url).pathname;
      const body = readRecordedJsonBody(request) as Record<string, unknown> | undefined;
      if (request.method === 'POST' && pathname === `/repos/${route}/issues`) {
        issue = { ...issue, ...body, assignees: (body?.assignees as string[] ?? []).map((login) => ({ login })), labels: (body?.labels as string[] ?? []).map((name) => ({ name })) };
        return { status: 201, body: issue };
      }
      if (pathname === `/repos/${route}/issues/${issueNumber}`) {
        if (request.method === 'PATCH') {
          issue = { ...issue, ...body };
          if (body?.title === 'Updated task') issue = { ...issue,
            assignees: [...issue.assignees as { login: string }[], { login: 'concurrent-owner' }],
            labels: [...issue.labels as { name: string }[], { name: 'concurrent-label' }],
          };
        }
        return { status: 200, body: issue };
      }
      if (pathname.endsWith('/assignees')) {
        const named = body?.assignees as string[];
        const prior = issue.assignees as { login: string }[];
        issue = { ...issue, assignees: request.method === 'POST' ? [...prior, ...named.map((login) => ({ login }))] : prior.filter(({ login }) => !named.includes(login)) };
        return { status: 200, body: issue };
      }
      if (pathname.endsWith('/labels') && request.method === 'POST') {
        issue = { ...issue, labels: [...issue.labels as { name: string }[], ...(body?.labels as string[]).map((name) => ({ name }))] };
        return { status: 200, body: issue.labels };
      }
      if (pathname.endsWith('/labels/old-label')) {
        issue = { ...issue, labels: (issue.labels as { name: string }[]).filter(({ name }) => name !== 'old-label') };
        return { status: 200, body: issue.labels };
      }
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      expect(await plugin.invokeAction('github/issue/create', { v: 1, instance, kindId: 'issue',
        initialStatusId: 'native-state', fields: { title: 'Created task', scopeId: route },
      })).toEqual({ kind: 'refused', reason: 'unsupported_field' });
      expect(transport.requests).toHaveLength(0);
      const createdRaw = await plugin.invokeAction('github/issue/create', {
        v: 1, instance: { ...instance, configuration: { v: 1, token: JSON.stringify({ v: 1,
          selection: { kind: 'selected', unitIds: [route] } }) } },
        kindId: 'issue', fields: { title: 'Created task', body: 'Details', assigneeIds: ['old-owner'], labelIds: ['old-label'] },
      });
      const created = TriageTaskWriteResultV1Schema.parse(createdRaw);
      expect(created).toMatchObject({ kind: 'applied', observation: { kind: 'present', snapshot: { title: 'Created task', scopeUnitId: route } } });
      const edited = TriageTaskWriteResultV1Schema.parse(await plugin.invokeAction('github/issue/edit', {
        v: 1, instance, localRef, lastKnownLocator: locator,
        fields: { title: 'Updated task', body: 'Changed', assigneeIds: ['new-owner'], labelIds: ['new-label'] },
      }));
      expect(edited).toMatchObject({ kind: 'applied', observation: { kind: 'present', snapshot: { title: 'Updated task' } } });
      expect(issue.assignees).toEqual([{ login: 'concurrent-owner' }, { login: 'new-owner' }]);
      expect(issue.labels).toEqual([{ name: 'concurrent-label' }, { name: 'new-label' }]);
      const beforeTransition = transport.requests.length;
      expect(await plugin.invokeAction('github/issue/transition', {
        v: 1, instance, localRef, lastKnownLocator: locator, transitionId: 'not_planned',
        fieldValues: [{ fieldId: 'resolution', value: 'done' }],
      })).toEqual({ kind: 'refused', reason: 'unsupported_field' });
      expect(transport.requests).toHaveLength(beforeTransition);
      const closed = TriageTaskWriteResultV1Schema.parse(await plugin.invokeAction('github/issue/transition', {
        v: 1, instance, localRef, lastKnownLocator: locator, transitionId: 'not_planned', fieldValues: [],
      }));
      expect(closed).toMatchObject({ kind: 'applied', observation: { snapshot: { state: { presentation: 'closed', completionReason: 'canceled' } } } });
      const writes = transport.requests.filter(({ method }) => method !== 'GET');
      expect(writes.filter(({ method, url }) => method === 'POST' && new URL(url).pathname === `/repos/${route}/issues`)).toHaveLength(1);
      expect(writes.filter(({ method }) => method === 'PATCH').map(readRecordedJsonBody)).toEqual([
        { title: 'Updated task', body: 'Changed' }, { state: 'closed', state_reason: 'not_planned' },
      ]);
    } finally { await plugin.dispose(); }
  });

  it('does not replay a create whose response is lost or guess the created identity', async () => {
    const transport = createStubGithubTransport({ respond: (request) => {
      if (request.method === 'POST') throw new Error('response lost after dispatch');
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const raw = await plugin.invokeAction('github/issue/create', {
        v: 1, instance, kindId: 'issue', fields: { title: 'Once' },
      });
      const result = TriageTaskWriteResultV1Schema.parse(raw);
      expect(result).toMatchObject({ kind: 'uncertain' });
      expect(transport.requests.filter(({ method }) => method === 'POST')).toHaveLength(1);
    } finally { await plugin.dispose(); }
  });

  it('reports a created issue with silently ignored assignments as uncertain without creating again', async () => {
    const issue = { ...GITHUB_ISSUE_RESPONSE, repository_url: `https://api.github.com/repos/${route}`,
      html_url: `https://github.com/${route}/issues/${issueNumber}`, title: 'Created once', assignees: [], labels: [] };
    const transport = createStubGithubTransport({ respond: (request) => {
      if (request.method === 'POST') return { status: 201, body: issue };
      if (new URL(request.url).pathname.endsWith(`/issues/${issueNumber}`)) return { status: 200, body: issue };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const result = TriageTaskWriteResultV1Schema.parse(await plugin.invokeAction('github/issue/create', {
        v: 1, instance, kindId: 'issue', fields: { title: 'Created once', assigneeIds: ['owner'], labelIds: ['bug'] },
      }));
      expect(result).toMatchObject({ kind: 'uncertain', observation: { kind: 'present', localRef, snapshot: { title: 'Created once' } } });
      expect(transport.requests.filter(({ method }) => method === 'POST')).toHaveLength(1);
    } finally { await plugin.dispose(); }
  });

  it('refuses unsupported fields before HTTP and reports partial edits as uncertain', async () => {
    let title = 'Before';
    const transport = createStubGithubTransport({ respond: (request) => {
      if (request.method === 'PATCH') {
        title = 'Changed';
        return { status: 200, body: {} };
      }
      if (request.method === 'POST') return { status: 403, body: { message: 'Forbidden' } };
      if (new URL(request.url).pathname.endsWith(`/issues/${issueNumber}`)) return { status: 200, body: {
        ...GITHUB_ISSUE_RESPONSE, repository_url: `https://api.github.com/repos/${route}`, title, labels: [], assignees: [],
      } };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      expect(await plugin.invokeAction('github/issue/edit', {
        v: 1, instance, localRef, lastKnownLocator: locator, fields: { parent: null },
      })).toMatchObject({ kind: 'refused' });
      expect(transport.requests).toHaveLength(0);
      const result = TriageTaskWriteResultV1Schema.parse(await plugin.invokeAction('github/issue/edit', {
        v: 1, instance, localRef, lastKnownLocator: locator, fields: { title: 'Changed', labelIds: ['bug'] },
      }));
      expect(result).toMatchObject({ kind: 'uncertain', observation: { kind: 'present', snapshot: { title: 'Changed' } }, failure: { class: 'permission' } });
      expect(transport.requests.filter(({ method }) => method === 'PATCH')).toHaveLength(1);
    } finally { await plugin.dispose(); }
  });

  it.each(['named', 'repository-id'] as const)('reads live parent, paged %s sub-issues and blocked-by identities without inventing missing permissions', async (routeKind) => {
    let denied = false;
    const related = (number: number, state = 'open') => ({ ...GITHUB_ISSUE_RESPONSE, number, state, html_url: `https://github.com/${route}/issues/${number}`, repository_url: `https://api.github.com/repos/${route}` });
    const crossRepository = 'other-org/child-repo';
    const child = { ...related(43, 'closed'), title: 'Cross-repository\nchild',
      repository: { id: 9876, owner: { login: 'other-org' }, name: 'child-repo' },
      repository_url: `https://api.github.com/repos/${crossRepository}`,
      html_url: `https://github.com/${crossRepository}/issues/43` };
    const transport = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith(`/issues/${issueNumber}`)) return { status: 200, body: { ...related(Number(issueNumber)), sub_issues_summary: { total: 2, completed: 1 } } };
      if (denied && /parent|sub_issues|blocked_by/u.test(url.pathname)) return { status: 403, body: { message: 'Forbidden' } };
      if (url.pathname.endsWith('/parent')) return { status: 200, body: related(41) };
      if (url.pathname.endsWith('/sub_issues')) return url.searchParams.get('page') === '2'
        ? { status: 200, body: [child] }
        : { status: 200, body: [{ ...related(42), title: 'First native child' }], headers: { link: `<${routeKind === 'named' ? url.toString()
          : url.toString().replace(`/repos/${route}/`, `/repositories/${String(GITHUB_REPOSITORY_RESPONSE.id)}/`)}&page=2>; rel="next"` } };
      if (url.pathname.endsWith('/dependencies/blocked_by')) return { status: 200, body: [related(44)] };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const result = TriageGetResultV1Schema.parse(await plugin.invokeAction('triage/get-github-entry', { v: 1, instance, localRef, lastKnownLocator: locator }));
      expect(result).toMatchObject({ kind: 'present', snapshot: { relations: {
        parent: { ...localRef, entryId: '41', source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } },
        children: { total: 2, completed: 1, complete: true, entries: [
          expect.objectContaining({ entryId: '42', title: 'First native child',
            locator: { v: 1, routingToken: route, displayPath: `${route}#42`, webUrl: `https://github.com/${route}/issues/42` } }),
          expect.objectContaining({ entryId: '43', collisionScope: 'github:9876', title: 'Cross-repository child',
            locator: { v: 1, routingToken: crossRepository, displayPath: `${crossRepository}#43`, webUrl: child.html_url } }),
        ] },
        blockedBy: [expect.objectContaining({ entryId: '44' })],
      } } });
      // Titles and routing come from the same paged relation DTOs: no per-child
      // issue or repository read is needed to present the returned child rows.
      expect(transport.requests.map(({ url }) => new URL(url).pathname).sort()).toEqual([
        `/repos/${route}`, `/repos/${route}/issues/${issueNumber}`,
        `/repos/${route}/issues/${issueNumber}/parent`,
        `/repos/${route}/issues/${issueNumber}/sub_issues`,
        routeKind === 'named' ? `/repos/${route}/issues/${issueNumber}/sub_issues`
          : `/repositories/${String(GITHUB_REPOSITORY_RESPONSE.id)}/issues/${issueNumber}/sub_issues`,
        `/repos/${route}/issues/${issueNumber}/dependencies/blocked_by`,
      ].sort());
      denied = true;
      const unavailable = TriageGetResultV1Schema.parse(await plugin.invokeAction('triage/get-github-entry', { v: 1, instance, localRef, lastKnownLocator: locator }));
      expect(unavailable.kind).toBe('present');
      if (unavailable.kind !== 'present') throw new Error('The issue remains readable');
      expect(unavailable.snapshot.relations).toEqual({ children: { total: 2, completed: 1 } });
    } finally { await plugin.dispose(); }
  });
});
