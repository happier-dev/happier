import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';
import { MAX_TRIAGE_LOCATION_UTF8_BYTES_V1, MAX_TRIAGE_TEXT_UTF8_BYTES_V1, TriagePullRequestStatusResultV1Schema, type TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { projectPullRequestStatusFactsV1 } from '../../../triage/src/sessions/pullRequestGlance/glanceModel.js';
import { presentTriageMergeReadinessV1 } from '../../../triage/src/ui/header/mergeReadiness.js';

import { activate, activateAccount } from '../activate.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1, PLUGIN_MANIFEST } from '../manifest.js';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../observations/githubProviderContracts.js';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_ISSUE_RESPONSE,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_REPOSITORY_RESPONSE,
  githubChangedFile,
  githubCheckRun,
  githubCheckRunsResponse,
  githubCombinedStatusResponse,
  githubCommitStatus,
  githubFollowUpLinkHeader,
  githubTimelineEvent,
} from './__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import {
  GithubCapabilitiesResultV1Schema,
  GithubChangedFilesResultV1Schema,
  GithubChecksResultV1Schema,
  GithubFeedbackResultV1Schema,
  GithubOverviewResultV1Schema,
  GithubTimelineResultV1Schema,
} from './detail/contracts.js';
import { decodeGithubDetailContinuation, encodeGithubDetailContinuation } from './detail/continuation.js';
import { githubNativeReadActionId } from './readActions.js';
import {
  readGithubCapabilities,
  readGithubOverview,
  listGithubChangedFiles,
  readGithubFeedback,
  listGithubTimeline,
  readGithubChecks,
  readGithubPullRequestStatus,
} from './detailOperations.js';
import {
  createStubGithubTransport,
  readRecordedJsonBody,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
const HEAD_SHA = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
const BASE_SHA = '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e';
const CONFIGURED_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'configured-account',
});

function configuredInstance(purpose = GITHUB_CONNECTED_ACCOUNT_PURPOSE): TriageConfiguredSourceInstanceV1 {
  const token = encodeGithubTriageConfiguration({
    v: 1,
    scope: { kind: 'repository', repositoryKey: REPOSITORY_KEY },
  });
  if (token === null) throw new Error('the fixture configuration must encode');
  const fixture = createTriageSourceV1Fixture();
  return Object.freeze({
    ...fixture.configuredInstance,
    instance: Object.freeze({
      source: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }),
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
    }),
    binding: Object.freeze({ purpose, account: CONFIGURED_ACCOUNT }),
    localInstanceKey: 'github.com',
    configuration: Object.freeze({ v: 1 as const, token }),
  });
}

const PULL_REQUEST_REF = Object.freeze({
  kindId: 'pull-request',
  collisionScope: 'github:4210',
  entryId: '1284',
});
const ISSUE_REF = Object.freeze({
  kindId: 'issue',
  collisionScope: 'github:4210',
  entryId: '1284',
});

describe('registered native PR status observation', () => {
  it('observes the exact declared credential purpose without executing or materializing the provider read', async () => {
    const caller = new AbortController();
    const stub = createStubGithubTransport({ signal: caller.signal, respond: () => undefined });
    const invalidated = Object.assign(vi.fn(), { retire: vi.fn() });
    const disposed = vi.fn();
    let notify: (() => void) | undefined;
    const watch = vi.fn((purpose: string, listener: Parameters<PluginInvocationContext['services']['connectedAccounts']['watch']>[1]) => {
      expect(purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
      notify = () => listener({ kind: 'resync' });
      return { dispose: disposed };
    });
    const context: PluginInvocationContext = { ...stub.context, services: { ...stub.context.services,
      connectedAccounts: { ...stub.context.services.connectedAccounts, watch },
    } };
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
    try {
      expect(PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === GITHUB_TRIAGE_ACTION_IDS_V1.readPullRequestStatus)?.readOnly).toBe(true);
      const subscription = await plugin.observeAction(GITHUB_TRIAGE_ACTION_IDS_V1.readPullRequestStatus, { v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF,
        lastKnownLocator: { v: 1, webUrl: 'https://github.com/example/repository/pull/1284', displayPath: 'PR #1284', routingToken: REPOSITORY_KEY },
      }, invalidated, { signal: context.signal, services: context.services });
      expect(watch).toHaveBeenCalledOnce();
      expect(stub.requests).toHaveLength(0);
      expect(stub.materializeCount()).toBe(0);
      notify?.();
      expect(invalidated).not.toHaveBeenCalled();
      notify?.();
      expect(invalidated).not.toHaveBeenCalled();
      expect(stub.requests).toHaveLength(0);
      expect(stub.materializeCount()).toBe(0);
      caller.abort();
      expect(disposed).toHaveBeenCalledOnce();
      await subscription.dispose();
      expect(disposed).toHaveBeenCalledOnce();
      notify?.();
      expect(invalidated).not.toHaveBeenCalled();
    } finally { caller.abort(); await plugin.dispose(); }
  });

  it('rejects a foreign configured purpose before installing a credential observer', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const watch = vi.fn(() => ({ dispose() {} }));
    const context: PluginInvocationContext = { ...stub.context, services: { ...stub.context.services,
      connectedAccounts: { ...stub.context.services.connectedAccounts, watch },
    } };
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
    try {
      await expect(plugin.observeAction(GITHUB_TRIAGE_ACTION_IDS_V1.readPullRequestStatus, { v: 1, instance: configuredInstance('other-purpose'), localRef: PULL_REQUEST_REF },
        Object.assign(() => {}, { retire() {} }), { signal: context.signal, services: context.services })).rejects.toMatchObject({ code: 'plugin_action_read_observation_unavailable' });
      expect(watch).not.toHaveBeenCalled();
      expect(stub.requests).toHaveLength(0);
    } finally { await plugin.dispose(); }
  });
});

it('propagates the caller-owned invocation lifetime through a never-settling detail read', async () => {
  const caller = new AbortController();
  const stub = createStubGithubTransport({
    signal: caller.signal,
    respond: (request) => new URL(request.url).pathname.endsWith('/timeline')
      ? new Promise<StubHttpResponse>(() => {})
      : undefined,
  });
  const pending = listGithubTimeline(planeInput(), stub.context);

  caller.abort(new DOMException('The host invocation reached its deadline.', 'TimeoutError'));

  await expect(pending).resolves.toEqual({
    kind: 'unavailable',
    failure: { class: 'transient', code: 'github_request_timed_out' },
  });
});

function planeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    limit: 50,
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Readonly<Record<string, string>> = {}): StubHttpResponse {
  return { status: 200, headers: { 'content-type': 'application/json', ...headers }, body };
}

describe('GitHub capability plane', () => {
  it('projects repository facts through the registered Action without a duplicate fetch', async () => {
    const repositoryBody = {
      id: 4210,
      archived: false,
      has_issues: true,
      allow_merge_commit: true,
      allow_squash_merge: false,
      allow_rebase_merge: true,
      permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    };
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname
        === `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`
        ? jsonResponse(repositoryBody)
        : undefined,
    });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    try {
      const result = GithubCapabilitiesResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities, {
        v: 1,
        instance: configuredInstance(),
        localRef: PULL_REQUEST_REF,
        routingToken: REPOSITORY_KEY,
      }));
      expect(result.kind).toBe('capabilities');
      if (result.kind !== 'capabilities') return;
      expect(result).toHaveProperty('mergeSettings', { merge: true, squash: false, rebase: true });
      expect(result.mergeMethods.squash).toEqual({ kind: 'unavailable', code: 'repository_unsupported' });
      expect(result.operations.pullRequestSubmitReview).toEqual({ kind: 'available' });
      expect(result.operations.pullRequestReviewCommentCreate).toEqual({ kind: 'available' });
      expect(result.operations.pullRequestMerge).toEqual({ kind: 'available' });
      expect(stub.requests.filter((request) =>
        new URL(request.url).pathname === `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`))
        .toHaveLength(1);
    } finally { await plugin.dispose(); }
  });
});

describe('registered GitHub issue facts read', () => {
  it('refuses a pull request before reading issue facts', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    try {
      expect(await plugin.invokeAction(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readIssueFacts, {
        v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
      })).toEqual({ kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_detail_kind_unsupported' } });
      expect(stub.requests).toHaveLength(0);
    } finally { await plugin.dispose(); }
  });

  it.each([
    { native: false, isPinned: true, viewerSubscription: 'SUBSCRIBED' },
    { native: false, isPinned: false, viewerSubscription: 'IGNORED' },
    { native: true, isPinned: false, viewerSubscription: 'UNSUBSCRIBED' },
  ])('reads current issue facts with one request (%j)', async ({ native, ...facts }) => {
    const stub = createStubGithubTransport({ respond: request => new URL(request.url).pathname === '/graphql'
      ? jsonResponse({ data: { repository: { databaseId: 4210, issue: facts } } }) : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    try {
      const actionId = GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readIssueFacts;
      const result = await plugin.invokeAction(native ? githubNativeReadActionId(actionId) : actionId, {
        v: 1, instance: configuredInstance(), localRef: ISSUE_REF, routingToken: REPOSITORY_KEY,
      });
      expect(result).toEqual({ kind: 'issueFacts', ...facts });
      expect(stub.requests).toHaveLength(1);
      expect(readRecordedJsonBody(stub.requests[0]!)).toMatchObject({
        variables: { owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY, number: 1284 },
        query: expect.stringContaining('isPinned viewerSubscription'),
      });
    } finally { await plugin.dispose(); }
  });

  it.each([
    { body: { errors: [{ type: 'FORBIDDEN' }], data: null }, failure: { class: 'permission', code: 'github_forbidden' } },
    { body: { data: { repository: { databaseId: 4210, issue: { isPinned: true, viewerSubscription: null } } } },
      failure: { class: 'unsupportedContract', code: 'github_graphql_response_invalid' } },
    { body: { data: { repository: { databaseId: 4210, issue: { isPinned: null, viewerSubscription: 'UNSUBSCRIBED' } } } },
      failure: { class: 'unsupportedContract', code: 'github_graphql_response_invalid' } },
    { body: { data: { repository: { databaseId: 9999, issue: { isPinned: false, viewerSubscription: 'SUBSCRIBED' } } } },
      failure: { class: 'unknown', code: 'route-body-mismatch' } },
  ])('preserves a typed issue-facts failure without guessed state (%j)', async ({ body, failure }) => {
    const stub = createStubGithubTransport({ respond: request => new URL(request.url).pathname === '/graphql'
      ? jsonResponse(body) : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    try {
      expect(await plugin.invokeAction(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readIssueFacts, {
        v: 1, instance: configuredInstance(), localRef: ISSUE_REF, routingToken: REPOSITORY_KEY,
      })).toEqual({ kind: 'unavailable', failure });
      expect(stub.requests).toHaveLength(1);
    } finally { await plugin.dispose(); }
  });
});

/* --------------------------------------------------------------------- overview */

describe('GitHub overview plane', () => {
  it('reads paged native property choices only on demand through the existing overview Action', async () => {
    const directoryRequests: string[] = [];
    const stub = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/pulls/1284')) return jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      if (url.pathname.endsWith('/assignees')) {
        directoryRequests.push(request.url);
        return url.searchParams.get('page') === '2'
          ? jsonResponse([{ login: 'hubot', id: 2 }])
          : jsonResponse([{ login: 'monalisa', id: 1, avatar_url: 'https://example.com/avatar' }], {
            link: `<https://api.github.com/repositories/4210/assignees?per_page=100&page=2>; rel="next"`,
          });
      }
      if (url.pathname.endsWith('/labels')) {
        directoryRequests.push(request.url);
        return jsonResponse([{ name: ' needs review ', id: 3, description: 'Native label' }]);
      }
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    const input = { v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY };
    try {
      const ordinary = await plugin.invokeAction(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, input);
      expect(ordinary).toMatchObject({ kind: 'overview', kindId: 'pull-request' });
      expect(ordinary).not.toHaveProperty('propertyChoices');
      expect(directoryRequests).toEqual([]);
      const result = GithubOverviewResultV1Schema.parse(await plugin.invokeAction(
        GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview, { ...input, includePropertyChoices: true },
      ));
      expect(result).toMatchObject({ kind: 'overview', kindId: 'pull-request', propertyChoices: {
        assignees: { kind: 'available', choices: [{ login: 'monalisa' }, { login: 'hubot' }] },
        labels: { kind: 'available', choices: [' needs review '] },
      } });
      expect(directoryRequests).toHaveLength(3);
      expect(stub.materializeCount()).toBe(2);
    } finally { await plugin.dispose(); }
  });

  it.each([
    { scenario: 'permission denial', response: { status: 403, body: { message: 'Resource not accessible' } }, failure: { class: 'permission', code: 'github_forbidden' } },
    { scenario: 'invalid member', response: jsonResponse([{ id: 1 }]), failure: { class: 'unsupportedContract', code: 'github_property_choices_response_invalid' } },
    { scenario: 'unsafe pagination', response: jsonResponse([{ login: 'hubot' }], { link: '<https://example.com/assignees?per_page=100&page=2>; rel="next"' }), failure: { class: 'unsupportedContract', code: 'github_property_choices_pagination_invalid' } },
  ])('keeps overview and labels when assignee choices report $scenario, and supports a fresh retry', async ({ response, failure }) => {
    let retry = false;
    const stub = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      if (path.endsWith('/assignees')) return retry ? jsonResponse([{ login: 'hubot' }]) : response;
      if (path.endsWith('/labels')) return jsonResponse([{ name: 'bug' }]);
      return undefined;
    } });
    const input = { v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
      includePropertyChoices: true };
    expect(GithubOverviewResultV1Schema.parse(await readGithubOverview(input, stub.context))).toMatchObject({
      kind: 'overview', title: GITHUB_PULL_REQUEST_RESPONSE.title,
      propertyChoices: { assignees: { kind: 'unavailable', failure }, labels: { kind: 'available', choices: ['bug'] } },
    });
    retry = true;
    expect(GithubOverviewResultV1Schema.parse(await readGithubOverview(input, stub.context))).toMatchObject({
      kind: 'overview', propertyChoices: { assignees: { kind: 'available', choices: [{ login: 'hubot' }] } },
    });
  });

  it('keeps the overview and sibling directory when native property choices exceed the canonical Action envelope', async () => {
    const people = Array.from({ length: Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 39) + 100 }, (_, index) => ({
      login: `person-${index}`.padEnd(39, 'x'),
    }));
    const stub = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/pulls/1284')) return jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      if (url.pathname.endsWith('/assignees')) {
        const page = Number(url.searchParams.get('page'));
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        return jsonResponse(people.slice((page - 1) * 100, page * 100),
          page * 100 < people.length ? { link: `<${next.toString()}>; rel="next"` } : {});
      }
      if (url.pathname.endsWith('/labels')) return jsonResponse([{ name: 'bug' }]);
      return undefined;
    } });
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
      includePropertyChoices: true,
    }, stub.context));
    expect(result).toMatchObject({ kind: 'overview', title: GITHUB_PULL_REQUEST_RESPONSE.title, propertyChoices: {
      assignees: { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_property_choices_response_too_large' } },
      labels: { kind: 'available', choices: ['bug'] },
    } });
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(stub.requests.filter(request => new URL(request.url).pathname.endsWith('/assignees')))
      .toHaveLength(Math.ceil(people.length / 100));
  });

  it('distinguishes an empty native property directory from a refused label directory', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      if (path.endsWith('/assignees')) return jsonResponse([]);
      if (path.endsWith('/labels')) return { status: 403, body: { message: 'Resource not accessible' } };
      return undefined;
    } });
    expect(GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
      includePropertyChoices: true,
    }, stub.context))).toMatchObject({ kind: 'overview', propertyChoices: {
      assignees: { kind: 'available', choices: [] },
      labels: { kind: 'unavailable', failure: { class: 'permission', code: 'github_forbidden' } },
    } });
  });

  it('refreshes one exact pull request into its current Markdown and branch facts', async () => {
    const observedAtMs = Date.parse('2026-08-31T10:11:12Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(observedAtMs);
    const pullRequest = {
      ...GITHUB_PULL_REQUEST_RESPONSE,
      mergeable_state: 'behind',
      assignees: [{ login: 'hubot' }],
      requested_reviewers: [{ login: 'monalisa' }],
      requested_teams: [{ slug: 'client-platform' }],
      milestone: { title: 'August' },
    };
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? jsonResponse(pullRequest)
        : undefined,
    });

    try {
      const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
        v: 1,
        instance: configuredInstance(),
        localRef: PULL_REQUEST_REF,
        routingToken: REPOSITORY_KEY,
      }, stub.context));

      expect(result).toEqual({
        kind: 'overview',
        kindId: 'pull-request',
        observedAtMs,
        title: 'Stream terminal frames without a full re-render',
        state: 'open',
        draft: false,
        merged: false,
        locked: false,
        author: 'octocat',
        createdAtMs: Date.parse('2026-08-01T09:14:22Z'),
        updatedAtMs: Date.parse('2026-08-12T18:03:40Z'),
        body: 'Reworks the frame pump.',
        webUrl: `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pull/1284`,
        labels: ['performance'],
        assignees: ['hubot'],
        milestone: 'August',
        headBranch: 'frame-pump',
        baseBranch: 'main',
        requestedReviewers: [
          { kind: 'user', subject: 'monalisa' },
          { kind: 'team', subject: 'client-platform' },
        ],
        headRevision: HEAD_SHA,
        additions: 214,
        deletions: 88,
        changedFiles: 12,
        branchUpdateEligibility: 'behind',
        mergeable: true,
        mergeableState: 'behind',
        requiredChecks: { state: 'unknown', failingCount: null, pendingCount: null },
        reviewDecision: null,
        // The unread rollup is the detail's checks answer too: unknown, never "no checks".
        checks: expect.objectContaining({ headRevision: HEAD_SHA, state: 'unknown', rows: [],
          checkRunsFailure: { class: 'transient', code: 'github_request_failed' } }),
        pullRequestStatus: expect.objectContaining({
          kind: 'status',
          observedAtMs,
          branch: { head: 'frame-pump', base: 'main', headRevision: HEAD_SHA, additions: 214, deletions: 88 },
          merge: expect.objectContaining({ state: 'unknown', blocker: null }),
          checks: expect.objectContaining({
            state: 'unknown',
            incomplete: true,
            failure: { class: 'transient', code: 'github_request_failed' },
          }),
        }),
      });
      expect(stub.requests.filter((request) => new URL(request.url).pathname.endsWith('/pulls/1284')))
        .toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { draft: true, mergeable: true, nativeState: 'blocked', requiredConclusion: 'FAILURE', requiredStatus: 'COMPLETED', state: 'failed', failingCount: 1, pendingCount: 0, viewerSubscription: 'SUBSCRIBED' },
    { draft: false, mergeable: false, nativeState: 'dirty', requiredConclusion: null, requiredStatus: 'IN_PROGRESS', state: 'pending', failingCount: 0, pendingCount: 1, viewerSubscription: 'UNSUBSCRIBED' },
    { draft: false, mergeable: null, nativeState: 'unknown', requiredConclusion: 'SUCCESS', requiredStatus: 'COMPLETED', state: 'passed', failingCount: 0, pendingCount: 0, viewerSubscription: 'IGNORED' },
  ])('exposes native merge facts and only required check outcomes ($state) through the registered overview Action', async (shape) => {
    const stub = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse({
        ...GITHUB_PULL_REQUEST_RESPONSE, draft: shape.draft, mergeable: shape.mergeable,
        mergeable_state: shape.nativeState,
      });
      if (path === '/graphql') return jsonResponse({ data: { repository: { pullRequest: {
        headRefOid: HEAD_SHA, reviewDecision: 'CHANGES_REQUESTED',
        viewerSubscription: shape.viewerSubscription,
        commits: { nodes: [{ commit: { oid: HEAD_SHA, statusCheckRollup: { contexts: {
          nodes: [
            { __typename: 'CheckRun', id: 'required', name: 'Required check', isRequired: true,
              status: shape.requiredStatus, conclusion: shape.requiredConclusion,
              startedAt: '2026-08-31T10:00:00Z', completedAt: null },
            { __typename: 'CheckRun', id: 'optional', name: 'Optional failure', isRequired: false,
              status: 'COMPLETED', conclusion: 'FAILURE',
              startedAt: '2026-08-31T10:00:00Z', completedAt: null },
          ], pageInfo: { hasNextPage: false },
        } } } }] },
      } } } });
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    try {
      const result = GithubOverviewResultV1Schema.parse(await plugin.invokeAction(
        GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview,
        { v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY },
      ));
      expect(result).toMatchObject({ kind: 'overview', kindId: 'pull-request',
        draft: shape.draft, mergeable: shape.mergeable, mergeableState: shape.nativeState,
        requiredChecks: { state: shape.state, failingCount: shape.failingCount, pendingCount: shape.pendingCount },
        reviewDecision: 'changes-requested',
        viewerSubscription: shape.viewerSubscription,
      });
      // Header facts reuse one exact PR read and the existing body-free check-condition query;
      // no Feedback-body, check-log or closed-tab REST inventory fanout.
      expect(stub.requests.map((r) => new URL(r.url).pathname).sort()).toEqual([
        '/graphql',
        `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`,
      ].sort());
      const query = readRecordedJsonBody(stub.requests.find((r) => new URL(r.url).pathname === '/graphql')!);
      expect(query).toMatchObject({ query: expect.stringContaining('isRequired'), variables: expect.objectContaining({ number: 1284 }) });
      expect(query).toMatchObject({ query: expect.stringContaining('reviewDecision') });
      expect(query).toMatchObject({ query: expect.stringContaining('viewerSubscription') });
    } finally { await plugin.dispose(); }
  });

  it.each([null, undefined, 'UNKNOWN', true])('leaves an unreadable subscription fact absent (%s)', async (viewerSubscription) => {
    const stub = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      if (path === '/graphql') return jsonResponse({ data: { repository: { pullRequest: {
        headRefOid: HEAD_SHA, viewerSubscription,
        commits: { nodes: [{ commit: { oid: HEAD_SHA, statusCheckRollup: null } }] },
      } } } });
      return undefined;
    } });
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
    }, stub.context));
    expect(result).toMatchObject({ kind: 'overview', kindId: 'pull-request' });
    expect(result).not.toHaveProperty('viewerSubscription');
    expect(stub.requests.map(request => new URL(request.url).pathname).sort()).toEqual([
      '/graphql', `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`,
    ].sort());
  });

  it.each([
    { scenario: 'permission denial', status: 403, head: HEAD_SHA, expected: 'unknown' },
    { scenario: 'head advancement', status: 200, head: 'b'.repeat(40), expected: 'superseded' },
    { scenario: 'no returned check contexts', status: 200, head: HEAD_SHA, expected: 'none' },
  ])('keeps native overview facts when required-check evidence reports $scenario', async ({ status, head, expected }) => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      if (new URL(request.url).pathname !== '/graphql') return undefined;
      return { status, body: status !== 200 ? { message: 'Resource not accessible' } : {
        data: { repository: { pullRequest: { headRefOid: head, reviewDecision: null,
          commits: { nodes: [{ commit: { oid: head, statusCheckRollup: null } }] },
        } } },
      } };
    } });
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
    }, stub.context));
    expect(result).toMatchObject({ kind: 'overview', kindId: 'pull-request', draft: false,
      mergeable: true, mergeableState: 'clean', headRevision: HEAD_SHA,
      requiredChecks: { state: expected, failingCount: null, pendingCount: null }, reviewDecision: null,
    });
  });

  it('states an independent provider permission denial instead of rendering an empty overview', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? { status: 403, body: { message: 'Resource not accessible' } }
        : undefined,
    });

    expect(await readGithubOverview({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
    }, stub.context)).toEqual({
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    });
  });

  it('refreshes an issue without manufacturing pull-request-only fields', async () => {
    const issue = {
      ...GITHUB_ISSUE_RESPONSE,
      number: 1284,
      repository_url: `https://api.github.com/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`,
      html_url: `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/issues/1284`,
      labels: [{ name: 'bug' }],
      assignees: [{ login: 'hubot' }],
      milestone: { title: 'August' },
    };
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/issues/1284')
        ? jsonResponse(issue)
        : undefined,
    });

    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1,
      instance: configuredInstance(),
      localRef: ISSUE_REF,
      routingToken: REPOSITORY_KEY,
    }, stub.context));

    expect(result).toMatchObject({
      kind: 'overview',
      kindId: 'issue',
      title: 'Reconnect loop after a laptop resume',
      state: 'open',
      author: 'monalisa',
      body: 'The client reconnects in a loop after resume.',
      labels: ['bug'],
      assignees: ['hubot'],
      milestone: 'August',
    });
    expect(result).not.toHaveProperty('headBranch');
    expect(result).not.toHaveProperty('headRevision');
    expect(result).not.toHaveProperty('branchUpdateEligibility');
  });
});

/* --------------------------------------------------------------------- timeline */

describe('GitHub timeline plane', () => {
  it.each(['named', 'repository-id'] as const)('walks %s pages by minting its own position and never carrying a provider URL', async (routeKind) => {
    const stub = createStubGithubTransport({
      respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
        if (!request.url.includes('/issues/1284/timeline')) return undefined;
        const page = new URL(request.url).searchParams.get('page');
        if (page === '1') {
          return jsonResponse(
            [githubTimelineEvent({ id: 1, event: 'labeled', createdAt: '2026-08-01T00:00:00Z', label: 'bug' })],
            { link: githubFollowUpLinkHeader({ requestedUrl: routeKind === 'named' ? request.url
              : request.url.replace(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/`, '/repositories/4210/'), nextPage: 2 }) },
          );
        }
        return jsonResponse([
          githubTimelineEvent({ id: 2, event: 'closed', createdAt: '2026-08-02T00:00:00Z' }),
        ]);
      },
    });

    const first = await listGithubTimeline(planeInput(), stub.context);
    const parsedFirst = GithubTimelineResultV1Schema.parse(first);
    if (parsedFirst.kind !== 'timeline') throw new Error('the first page must settle as timeline');
    expect(parsedFirst.rows.map((row) => row.id)).toEqual(['github-timeline-event:1']);
    expect(parsedFirst.continuation).toBeDefined();
    // The token is this source's own bytes; a provider URL never reaches a panel.
    expect(parsedFirst.continuation).not.toContain('api.github.com');
    expect(parsedFirst.incomplete).toBeUndefined();

    const second = await listGithubTimeline(
      planeInput({ continuation: parsedFirst.continuation }),
      stub.context,
    );
    const parsedSecond = GithubTimelineResultV1Schema.parse(second);
    if (parsedSecond.kind !== 'timeline') throw new Error('the second page must settle as timeline');
    expect(parsedSecond.rows.map((row) => row.id)).toEqual(['github-timeline-event:2']);
    expect(parsedSecond.continuation).toBeUndefined();

    expect(stub.requests
      .filter((request) => request.url.includes('/timeline'))
      .map((request) => new URL(request.url).searchParams.get('page')))
      .toEqual(['1', '2']);
  });

  it('reads a provider-stated empty timeline as a settled page with no rows', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/timeline') ? jsonResponse([]) : undefined),
    });

    const result = GithubTimelineResultV1Schema.parse(
      await listGithubTimeline(planeInput(), stub.context),
    );
    // "Nothing here" and "we could not look" are different answers.
    expect(result.kind).toBe('timeline');
    if (result.kind !== 'timeline') return;
    expect(result.rows).toEqual([]);
    expect(result.continuation).toBeUndefined();
  });

  it('names itself when the first page is refused', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/timeline')
        ? {
          status: 403,
          headers: { 'x-accepted-github-permissions': 'issues=read' },
          body: { message: 'Resource not accessible' },
        }
        : undefined),
    });

    const result = GithubTimelineResultV1Schema.parse(
      await listGithubTimeline(planeInput(), stub.context),
    );
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'permission', code: 'insufficient_scope', detail: 'issues=read', requiredPermissions: 'issues=read' },
    });
  });

  it('refuses a continuation minted under a different page geometry', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const continuation = encodeGithubDetailContinuation({ v: 1, page: 3, perPage: 100 });

    const result = GithubTimelineResultV1Schema.parse(await listGithubTimeline(
      planeInput({ limit: 50, continuation }),
      stub.context,
    ));
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_detail_continuation_unreadable' },
    });
    // Resuming at a page that names different rows would silently skip content,
    // so nothing is requested at all.
    expect(stub.requests).toEqual([]);
  });

  it('reports a next page it will not follow instead of looking finished', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/timeline')
        ? jsonResponse(
          [githubTimelineEvent({ id: 1, event: 'closed', createdAt: '2026-08-01T00:00:00Z' })],
          // A cross-origin next URL is not the same request with only `page`
          // advanced, so it is refused rather than followed.
          { link: '<https://evil.example.com/repos/o/r/issues/1284/timeline?page=2>; rel="next"' },
        )
        : undefined),
    });

    const result = GithubTimelineResultV1Schema.parse(
      await listGithubTimeline(planeInput(), stub.context),
    );
    if (result.kind !== 'timeline') throw new Error('rows already read must survive');
    expect(result.rows).toHaveLength(1);
    expect(result.continuation).toBeUndefined();
    expect(result.incomplete).toBe('pagination');
  });

  it('makes no outbound call when the observed route cannot be parsed', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const result = GithubTimelineResultV1Schema.parse(await listGithubTimeline(
      planeInput({ routingToken: 'not-a-repository-key' }),
      stub.context,
    ));
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unknown', code: 'github_locator_unusable' },
    });
    expect(stub.requests).toEqual([]);
    expect(stub.materializeCount()).toBe(0);
  });

  it('refuses a configured instance bound to another purpose', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const result = GithubTimelineResultV1Schema.parse(await listGithubTimeline(
      planeInput({ instance: configuredInstance('some.other.purpose') }),
      stub.context,
    ));
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_instance_binding_foreign' },
    });
    expect(stub.requests).toEqual([]);
  });

  it('refuses the mutable repository route when it now names another immutable repository', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 8815, full_name: 'octo-org/example-app' });
        }
        if (pathname.endsWith('/issues/1284/timeline')) return jsonResponse([]);
        return undefined;
      },
    });

    const result = await listGithubTimeline(planeInput(), stub.context);
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unknown', code: 'route-body-mismatch' },
    });
    expect(stub.requests.some((request) => request.url.includes('/issues/1284/timeline')))
      .toBe(false);
  });
});

/* ---------------------------------------------------------------- changed files */

describe('GitHub changed-files plane', () => {
  it('reads one expanded file from its known page through the registered Action without publishing other bodies', async () => {
    const patch = '@@ -1 +1 @@\n-old  \n+new Ω  ';
    const body = Array.from({ length: 100 }, (_, index) => ({
      ...githubChangedFile({ filename: `src/file-${index}.ts` }),
      additions: 1, deletions: 1, changes: 2, patch,
    }));
    const stub = createStubGithubTransport({ respond: request => request.url.includes('/files?')
      ? jsonResponse(body) : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    const continuation = encodeGithubDetailContinuation({ v: 1, page: 2, perPage: 100 });
    try {
      const inventory = GithubChangedFilesResultV1Schema.parse(await plugin.invokeAction(
        GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles, planeInput({ limit: 100, continuation }),
      ));
      expect(inventory).toMatchObject({ kind: 'changedFiles', rows: expect.arrayContaining([expect.objectContaining({ path: 'src/file-42.ts' })]) });
      expect(JSON.stringify(inventory)).not.toContain('@@');
      const selected = GithubChangedFilesResultV1Schema.parse(await plugin.invokeAction(
        GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles,
        planeInput({ limit: 100, continuation, filePath: 'src/file-42.ts' }),
      ));
      expect(selected).toMatchObject({ kind: 'changedFiles', rows: [{
        path: 'src/file-42.ts', evidence: { state: 'available', patch },
      }] });
      if (selected.kind !== 'changedFiles') throw new Error('Expected the expanded file');
      expect(selected.rows).toHaveLength(1);
      expect(selected.comparison).toBeUndefined();
      const fileReads = stub.requests.filter(request => new URL(request.url).pathname.endsWith('/files'));
      expect(fileReads).toHaveLength(2); // One inventory page, one opened body; never walk the inventory.
      expect(fileReads.every(request => new URL(request.url).searchParams.get('page') === '2')).toBe(true);
      expect(stub.requests.some(request => new URL(request.url).pathname.endsWith('/pulls/1284'))).toBe(false);
    } finally { await plugin.dispose(); }
  });

  it('distinguishes an omitted file patch from a file that moved out of its known page', async () => {
    const stub = createStubGithubTransport({ respond: request => request.url.includes('/files?')
      ? jsonResponse([githubChangedFile({ filename: 'binary.dat', withPatch: false })]) : undefined });
    expect(GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({ filePath: 'binary.dat' }), stub.context,
    ))).toMatchObject({ kind: 'changedFiles', rows: [{ path: 'binary.dat', evidence: { state: 'unavailable', reason: 'provider_patch_missing' } }] });
    expect(GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({ filePath: 'moved.ts' }), stub.context,
    ))).toEqual({ kind: 'unavailable', failure: { class: 'transient', code: 'github_file_page_changed' } });
    expect(stub.requests.filter(request => new URL(request.url).pathname.endsWith('/files'))).toHaveLength(2);
  });

  it.each(['named', 'repository-id'] as const)('retains exact comparison patches and pins endpoints across %s source continuations', async (routeKind) => {
    const patch = '@@ -1 +1 @@\n-old  \n+new Ω  ';
    const mergeBaseOid = 'c'.repeat(40);
    const stub = createStubGithubTransport({
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname.includes('/compare/')) {
          expect(url.pathname).toBe(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/compare/${BASE_SHA}...${HEAD_SHA}`);
          return jsonResponse({ base_commit: { sha: BASE_SHA }, merge_base_commit: { sha: mergeBaseOid } });
        }
        if (url.pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 101 });
        if (!url.pathname.endsWith('/files')) return undefined;
        const paths = url.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, index) => `first-${index}.ts`) : ['second.ts'];
        return jsonResponse(paths.map((filename) => ({ ...githubChangedFile({ filename }), additions: 1, deletions: 1, changes: 2, patch })),
          url.searchParams.get('page') === '1' ? { link: githubFollowUpLinkHeader({ requestedUrl: routeKind === 'named' ? request.url
            : request.url.replace(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/`, '/repositories/4210/'), nextPage: 2 }) } : {});
      },
    });
    const first = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 100 }), stub.context));
    expect(first.kind).toBe('changedFiles');
    if (first.kind !== 'changedFiles') return;
    expect(first.rows[0]).toMatchObject({ evidence: { state: 'available', patch } });
    expect(first.rows).toHaveLength(100);
    expect(first.comparison).toMatchObject({ beforeOid: mergeBaseOid, baseOid: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e', headOid: HEAD_SHA, freshness: 'current', inventory: 'incomplete', content: 'complete', totalFileCount: 101 });
    expect(first.comparison).toMatchObject({ locator: { providerId: 'github', repository: REPOSITORY_KEY, number: 1284 } });
    const second = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 100, continuation: first.continuation }), stub.context));
    expect(second.kind).toBe('changedFiles');
    if (second.kind !== 'changedFiles') return;
    expect(second.rows[0]?.path).toBe('second.ts');
    expect(second.comparison).toMatchObject({ beforeOid: mergeBaseOid, inventory: 'complete', content: 'complete', enumeratedFileCount: 101 });
    expect(second.comparison).toMatchObject({ locator: { providerId: 'github', repository: REPOSITORY_KEY, number: 1284 } });
    expect(second.continuation).toBeUndefined();
    expect(stub.materializations.every((read) => read.account.accountId === CONFIGURED_ACCOUNT.accountId)).toBe(true);
  });

  it('keeps usable evidence when the metadata reread fails and refuses exact completeness', async () => {
    let metadataReads = 0;
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) {
        return ++metadataReads === 1 ? jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 }) : { status: 429, headers: { 'retry-after': '60' }, body: { message: 'rate limited' } };
      }
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'retained.ts' })]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') return;
    expect(result.rows[0]?.path).toBe('retained.ts');
    expect(result.comparison).toMatchObject({ freshness: 'unverified', inventory: 'incomplete', failure: { class: 'rateLimit' } });
  });

  it.each(['base', 'head'] as const)('marks page evidence stale if the %s endpoint changes during its read', async (endpoint) => {
    let reads = 0;
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE,
        changed_files: 1, [endpoint]: { sha: ++reads === 1 ? (endpoint === 'head' ? HEAD_SHA : '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e') : 'a'.repeat(40), repo: GITHUB_REPOSITORY_RESPONSE },
      });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'mixed.ts' })]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') return;
    expect(result.comparison).toMatchObject({ headOid: HEAD_SHA, freshness: 'stale', inventory: 'incomplete', reasons: expect.arrayContaining(['source_changed']) });
    expect(result.continuation).toBeUndefined();
  });

  it('keeps evidence incomplete when a provider continuation points outside its source route', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 2 });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'retained.ts' })], { link: '<https://other.example/steal?page=2>; rel="next"' }) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result).toMatchObject({ kind: 'changedFiles', incomplete: 'pagination', comparison: { inventory: 'incomplete', reasons: expect.arrayContaining(['pagination']) } });
    expect(stub.requests.some((request) => request.url.startsWith('https://other.example'))).toBe(false);
  });

  it.each(['comparison', 'expanded'] as const)('retains missing and truncated %s patch facts without normalizing exact paths or patch bytes', async (mode) => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 3 });
      return request.url.includes('/files') ? jsonResponse([
        githubChangedFile({ filename: 'bin.dat', withPatch: false }),
        { ...githubChangedFile({ filename: 'two  spaces.ts' }), additions: 2, deletions: 1, changes: 3, patch: '@@ -1 +1,2 @@\n-old\n+first' },
        { ...githubChangedFile({ filename: ' ' }), additions: 0, deletions: 0, changes: 0, patch: '' },
      ]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput(mode === 'comparison'
      ? { comparison: true } : { filePath: 'two  spaces.ts' }), stub.context));
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') return;
    if (mode === 'comparison') {
      expect(result.rows[0]?.evidence).toEqual({ state: 'unavailable', reason: 'provider_patch_missing' });
      expect(result.rows[2]).toMatchObject({ path: ' ', evidence: { state: 'available', patch: '' } });
      expect(result.comparison).toMatchObject({ inventory: 'complete', content: 'incomplete' });
    } else expect(result.rows).toHaveLength(1);
    expect(result.rows[mode === 'comparison' ? 1 : 0]).toMatchObject({ path: 'two  spaces.ts', evidence: { state: 'truncated', patch: '@@ -1 +1,2 @@\n-old\n+first', reason: 'provider_patch_truncated' } });
  });

  it.each(['comparison', 'expanded'] as const)('keeps file inventory and states the real Action envelope limit for an oversized %s patch', async (mode) => {
    const patch = '@@ -0,0 +1 @@\n+' + 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 });
      return request.url.includes('/files') ? jsonResponse([{ ...githubChangedFile({ filename: 'large.txt' }), additions: 1, deletions: 0, changes: 1, patch }]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput(mode === 'comparison'
      ? { comparison: true } : { filePath: 'large.txt' }), stub.context));
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') return;
    expect(result.rows[0]).toMatchObject({ path: 'large.txt', evidence: { state: 'unavailable', reason: 'transport_limit' } });
    if (mode === 'comparison') expect(result.comparison).toMatchObject({ inventory: 'complete', content: 'incomplete', reasons: expect.arrayContaining(['transport_limit']) });
  });

  it.each(['x', '"\\\tΩ😀'])('fits a full provider page with constant envelope serializations while retaining inventory and continuation (%j)', async unit => {
    // GitHub's real page geometry is 100 files; these exact patches together
    // exceed the existing Action envelope by a factor of two.
    const fileCount = 100;
    const encodedUnitBytes = new TextEncoder().encode(JSON.stringify(unit)).byteLength - 2;
    const patch = '@@ -0,0 +1 @@\n+' + unit.repeat(Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES * 2 / (fileCount * encodedUnitBytes)));
    const files = Array.from({ length: fileCount }, (_, index) => ({
      ...githubChangedFile({ filename: `file-${index}.txt` }), additions: 1, deletions: 0, changes: 1, patch,
    }));
    const stub = createStubGithubTransport({ respond: request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: fileCount + 1 });
      if (!url.pathname.endsWith('/files')) return undefined;
      return url.searchParams.get('page') === '1'
        ? jsonResponse(files, { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) })
        : jsonResponse([{ ...githubChangedFile({ filename: 'last.txt' }), additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+last' }]);
    } });
    // Observe the actual platform serialization boundary, leaving the shared
    // transport measurement and all provider projection/fitting logic real.
    const serialization = vi.spyOn(JSON, 'stringify');
    let envelopeSerializations: number;
    let result: ReturnType<typeof GithubChangedFilesResultV1Schema.parse>;
    try {
      result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: fileCount }), stub.context));
      // The canonical strict-JSON measurer serializes individual tokens. This
      // framing key occurs exactly once per complete Action envelope walk.
      envelopeSerializations = serialization.mock.calls.filter(([value]) => value === 'execution').length;
    } finally { serialization.mockRestore(); }
    expect(envelopeSerializations).toBe(2);
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') throw new Error('Expected the fitted comparison');
    expect(result.rows.map(row => row.path)).toEqual(files.map(file => file.filename));
    expect(result).toMatchObject({ omittedRowCount: 0, projectionTruncated: false,
      comparison: { content: 'incomplete', reasons: expect.arrayContaining(['pages_pending', 'transport_limit']) } });
    expect(result.rows.some(row => row.evidence?.state === 'available')).toBe(true);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    const omittedIndex = result.rows.findIndex(row => row.evidence?.state === 'unavailable' && row.evidence.reason === 'transport_limit');
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1({ ...result,
      rows: result.rows.map((row, index) => index === omittedIndex
        ? { ...row, evidence: { state: 'available', patch } } : row),
    })).toBe(false);
    expect(result.continuation).toBeDefined();
    expect(decodeGithubDetailContinuation(result.continuation!)?.comparison).toMatchObject({ contentIncomplete: true, inventoryIncomplete: false });
    const resumed = await listGithubChangedFiles(planeInput({ comparison: true, limit: fileCount, continuation: result.continuation }), stub.context);
    expect(resumed).toMatchObject({ kind: 'changedFiles', rows: [{ path: 'last.txt' }],
      comparison: { inventory: 'complete', content: 'incomplete', enumeratedFileCount: fileCount + 1 } });
  });

  it('retains complete exact patch content at the Action envelope boundary', async () => {
    const prefix = '@@ -0,0 +1 @@\n+';
    let patch = prefix + 'x';
    const stub = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 });
      return request.url.includes('/files') ? jsonResponse([{ ...githubChangedFile({ filename: 'boundary.txt' }), additions: 1, deletions: 0, changes: 1, patch }]) : undefined;
    } });
    const small = await listGithubChangedFiles(planeInput({ comparison: true }), stub.context);
    patch = prefix + 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - measureExternalActionResultResponseEnvelopeUtf8BytesV1(small) + 1);
    const result = await listGithubChangedFiles(planeInput({ comparison: true }), stub.context);
    expect(result).toMatchObject({ kind: 'changedFiles', rows: [{ path: 'boundary.txt', evidence: { state: 'available', patch } }],
      comparison: { content: 'complete', inventory: 'complete', reasons: [] } });
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(result)).toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
  });

  it.each(['base', 'head'] as const)('refuses a mixed comparison when the %s tip moves before the next page', async (endpoint) => {
    let headOid = HEAD_SHA;
    let baseOid = BASE_SHA;
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 2,
        base: { sha: baseOid, repo: GITHUB_REPOSITORY_RESPONSE }, head: { sha: headOid } });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'prefix.ts' })], { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) }) : undefined;
    } });
    const first = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1 }), stub.context));
    if (first.kind !== 'changedFiles') throw new Error('Expected the source prefix');
    if (endpoint === 'head') headOid = 'b'.repeat(40);
    else baseOid = 'b'.repeat(40);
    const second = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1, continuation: first.continuation }), stub.context));
    expect(second).toMatchObject({ kind: 'changedFiles', rows: [], comparison: { headOid: HEAD_SHA, freshness: 'stale', inventory: 'incomplete' } });
    expect(stub.requests.filter((request) => request.url.includes('/files'))).toHaveLength(1);
  });

  it.each(['missing', 'wrong-base', 'forbidden'] as const)('refuses exact comparison evidence when the merge-base attestation is %s', async (mode) => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.includes('/compare/')) return mode === 'forbidden'
        ? { status: 403, body: { message: 'Resource not accessible by integration' } }
        : jsonResponse({ base_commit: { sha: mode === 'wrong-base' ? 'a'.repeat(40) : BASE_SHA },
          ...(mode === 'missing' ? {} : { merge_base_commit: { sha: 'c'.repeat(40) } }) });
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'file.ts' })]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result).toMatchObject({ kind: 'unavailable', failure: { class: mode === 'forbidden' ? 'permission' : 'unsupportedContract' } });
  });

  it('returns a typed failed-page comparison without erasing a previously delivered prefix', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 2 });
      if (!url.pathname.endsWith('/files')) return undefined;
      return url.searchParams.get('page') === '1'
        ? jsonResponse([githubChangedFile({ filename: 'prefix.ts' })], { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) })
        : { status: 401, body: { message: 'Bad credentials' } };
    } });
    const first = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1 }), stub.context));
    if (first.kind !== 'changedFiles') throw new Error('Expected the source prefix');
    const second = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1, continuation: first.continuation }), stub.context));
    expect(second).toMatchObject({ kind: 'changedFiles', rows: [], comparison: { enumeratedFileCount: 1, inventory: 'incomplete', failure: { class: 'authentication' } } });
    expect(first.rows[0]?.path).toBe('prefix.ts');
  });

  it('rejects display-only or foreign-account continuations in comparison mode', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 2 });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'prefix.ts' })], { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) }) : undefined;
    } });
    const first = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1 }), stub.context));
    if (first.kind !== 'changedFiles') throw new Error('Expected the source prefix');
    const original = configuredInstance();
    const foreign = { ...original, binding: { ...original.binding, account: { ...CONFIGURED_ACCOUNT, accountId: 'other-account' } } };
    for (const input of [
      planeInput({ comparison: true, limit: 1, continuation: encodeGithubDetailContinuation({ v: 1, page: 2, perPage: 1 }) }),
      planeInput({ comparison: true, limit: 1, continuation: first.continuation, instance: foreign }),
    ]) expect(await listGithubChangedFiles(input, stub.context)).toMatchObject({ kind: 'unavailable', failure: { code: 'github_detail_continuation_unreadable' } });
    expect(stub.requests.filter((request) => request.url.includes('/files'))).toHaveLength(1);
  });

  it('renders a complete walk as complete', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/pulls/1284/files')
        ? jsonResponse([
          githubChangedFile({ filename: 'src/pump.ts' }),
          githubChangedFile({ filename: 'src/huge.bin', withPatch: false }),
        ])
        : undefined),
    });

    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({ limit: 100 }),
      stub.context,
    ));
    if (result.kind !== 'changedFiles') throw new Error('the page must settle as changedFiles');
    expect(result.rows.map((row) => row.path)).toEqual(['src/pump.ts', 'src/huge.bin']);
    expect(result.rows.map((row) => row.diffAvailable)).toEqual([true, false]);
    expect(result.incomplete).toBeUndefined();
    expect(result.continuation).toBeUndefined();
  });

  it('stops at the documented 3,000-file ceiling and says so', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/pulls/1284/files')
        ? jsonResponse(
          [githubChangedFile({ filename: 'src/last.ts' })],
          // GitHub keeps advertising a next page it will never actually serve.
          { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 31 }) },
        )
        : undefined),
    });

    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({
        limit: 100,
        continuation: encodeGithubDetailContinuation({ v: 1, page: 30, perPage: 100 }),
      }),
      stub.context,
    ));
    if (result.kind !== 'changedFiles') throw new Error('the ceiling page must keep its rows');
    expect(result.rows).toHaveLength(1);
    // Known-incomplete is a rendered state, never a silent cap.
    expect(result.incomplete).toBe('ceiling');
    expect(result.continuation).toBeUndefined();
  });

  it('reports the ceiling on a terminal 3,000th-file page that advertises no next link', async () => {
    // GitHub documents the 3,000-file maximum but promises no `Link` past it, so the
    // exhausted-pagination shape is exactly what a capped walk looks like. Deriving the
    // boundary from the next link alone renders a capped list as a complete one.
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/pulls/1284/files')
        ? jsonResponse(Array.from(
          { length: 100 },
          (_unused, index) => githubChangedFile({ filename: `src/file-${index}.ts` }),
        ))
        : undefined),
    });

    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({
        limit: 100,
        continuation: encodeGithubDetailContinuation({ v: 1, page: 30, perPage: 100 }),
      }),
      stub.context,
    ));
    if (result.kind !== 'changedFiles') throw new Error('the ceiling page must keep its rows');
    expect(result.rows).toHaveLength(100);
    expect(result.incomplete).toBe('ceiling');
    expect(result.continuation).toBeUndefined();
  });

  it('renders a final page that stops one file below the ceiling as complete', async () => {
    // The neighbouring case: 2,999 files is a walk GitHub finished, not one it capped,
    // and claiming a ceiling there would invent an incompleteness the user cannot resolve.
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/pulls/1284/files')
        ? jsonResponse(Array.from(
          { length: 99 },
          (_unused, index) => githubChangedFile({ filename: `src/file-${index}.ts` }),
        ))
        : undefined),
    });

    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({
        limit: 100,
        continuation: encodeGithubDetailContinuation({ v: 1, page: 30, perPage: 100 }),
      }),
      stub.context,
    ));
    if (result.kind !== 'changedFiles') throw new Error('the short page must keep its rows');
    expect(result.rows).toHaveLength(99);
    expect(result.incomplete).toBeUndefined();
    expect(result.continuation).toBeUndefined();
  });

  it('refuses to answer for an issue rather than returning an empty file list', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({ localRef: ISSUE_REF, limit: 100 }),
      stub.context,
    ));
    // An empty list would claim "this pull request changes nothing".
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_detail_kind_unsupported' },
    });
    expect(stub.requests).toEqual([]);
  });
});

/* --------------------------------------------------------------------- feedback */

describe('GitHub feedback plane', () => {
  it('preserves the complete suggestion through the strict detail Action result', async () => {
    const stub = createStubGithubTransport({ respond: () => jsonResponse({ data: { repository: {
      databaseId: 4210, pullRequest: { reviewThreads: { nodes: [{ id: 'thread', isResolved: false,
        path: 'file.ts', line: 20, diffSide: 'RIGHT', firstComment: { totalCount: 1, nodes: [{
          id: 'comment', body: '```suggestion\nnew\n```', path: 'file.ts', line: 20, originalLine: 2,
          originalCommit: { oid: HEAD_SHA }, commit: { oid: BASE_SHA }, outdated: false,
          diffHunk: '@@ -1,2 +1,2 @@\n context\n-old\n+original',
        }] }, comments: { nodes: [], pageInfo: { hasPreviousPage: false } } }],
        pageInfo: { hasPreviousPage: false } } },
    } } }) });
    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({ v: 1, instance: configuredInstance(),
      localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY, connection: 'threads' }, stub.context));
    expect(result).toMatchObject({ kind: 'threads', rows: [{ firstReply: { suggestions: [{
      path: 'file.ts', commitOid: HEAD_SHA, startLine: 2, endLine: 2, originalLines: ['original'],
      replacement: 'new', outdated: false,
    }] } }] });
    expect(stub.requests).toHaveLength(1);
  });
  it.each([
    { status: 403, headers: { 'X-Accepted-GitHub-Permissions': 'pull_requests=read' }, body: {},
      failure: { class: 'permission', code: 'insufficient_scope', detail: 'pull_requests=read', requiredPermissions: 'pull_requests=read' } },
    { status: 403, headers: {}, body: {}, failure: { class: 'permission', code: 'github_forbidden' } },
    { status: 200, headers: {}, body: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }], data: null },
      failure: { class: 'permission', code: 'github_forbidden' } },
  ])('preserves provider permission evidence on a GraphQL read ($status, $failure.code)', async ({ status, headers, body, failure }) => {
    const stub = createStubGithubTransport({ respond: () => ({ status, headers, body }) });
    expect(GithubFeedbackResultV1Schema.parse(await readGithubFeedback({ v: 1, instance: configuredInstance(),
      localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY, connection: 'comments' }, stub.context)))
      .toEqual({ kind: 'unavailable', failure });
    expect(stub.requests.map(request => new URL(request.url).pathname)).toEqual(['/graphql']);
  });

  it('routes the newest pull-request conversation through the one GraphQL feedback fetcher', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 4210, full_name: 'octo-org/example-app' });
        }
        if (pathname !== '/graphql') return undefined;
        const body = readRecordedJsonBody(request) as {
          query: string;
          variables: Record<string, unknown>;
        };
        expect(body.query).toContain('GithubFeedbackComments');
        expect(body.variables).toMatchObject({
          owner: 'octo-org',
          name: 'example-app',
          number: 1284,
          commentCount: 24,
          commentCursor: null,
        });
        return jsonResponse({
          data: {
            repository: {
              databaseId: 4210,
              pullRequest: {
                comments: {
                  nodes: [
                    { id: 'IC_2', author: { login: 'later' }, body: 'later', createdAt: '2026-08-12T12:00:00Z', url: 'https://github.com/o/r/pull/1#issuecomment-2' },
                    { id: 'IC_1', author: { login: 'earlier' }, body: 'earlier', createdAt: '2026-08-11T12:00:00Z', url: 'https://github.com/o/r/pull/1#issuecomment-1' },
                  ],
                  pageInfo: { hasPreviousPage: true, startCursor: 'comments-before' },
                },
              },
            },
          },
        });
      },
    });

    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
      connection: 'comments',
    }, stub.context));

    expect(result).toMatchObject({
      kind: 'comments',
      previousCursor: 'comments-before',
      rows: [{ id: 'IC_1' }, { id: 'IC_2' }],
    });
    expect(stub.requests).toHaveLength(1);
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/graphql');
  });

  it.each(['reused-route', 'not-found'] as const)('refuses Feedback from %s in one provider read', async scenario => {
    const stub = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname === '/repos/octo-org/example-app') {
        return jsonResponse({ id: scenario === 'reused-route' ? 999 : 4210, full_name: REPOSITORY_KEY });
      }
      return jsonResponse(scenario === 'not-found'
        ? { errors: [{ type: 'NOT_FOUND' }], data: { repository: null } }
        : { data: { repository: { databaseId: 999, pullRequest: { comments: { nodes: [], pageInfo: { hasPreviousPage: false } } } } } });
    } });
    expect(await readGithubFeedback({ v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY, connection: 'comments' }, stub.context)).toMatchObject({
      kind: 'unavailable', failure: scenario === 'reused-route'
        ? { code: 'route-body-mismatch' } : { code: 'github_not_found' },
    });
    expect(stub.requests).toHaveLength(1);
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/graphql');
  });

  it('states when a provider cursor cannot cross the canonical Action envelope', async () => {
    const providerCursor = 'c'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES + 1);
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 4210, full_name: 'octo-org/example-app' });
        }
        if (pathname !== '/graphql') return undefined;
        return jsonResponse({
          data: {
            repository: {
              databaseId: 4210,
              pullRequest: {
                comments: {
                  nodes: [{ id: 'IC_1', body: 'kept', createdAt: '2026-08-11T12:00:00Z' }],
                  pageInfo: { hasPreviousPage: true, startCursor: providerCursor },
                },
              },
            },
          },
        });
      },
    });

    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
      connection: 'comments',
    }, stub.context));
    expect(result).toMatchObject({
      kind: 'comments',
      rows: [{ id: 'IC_1', body: 'kept' }],
      omittedRowCount: 0,
      projectionTruncated: false,
      incomplete: 'continuationUnavailable',
    });
    expect(result).not.toHaveProperty('previousCursor');
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
  });

  it('reports provider document rows omitted by the canonical Action envelope', async () => {
    const body = 'x'.repeat(
      Math.floor(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2) + 2_048,
    );
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 4210, full_name: 'octo-org/example-app' });
        }
        if (pathname !== '/graphql') return undefined;
        return jsonResponse({
          data: {
            repository: {
              databaseId: 4210,
              pullRequest: {
                comments: {
                  nodes: [
                    { id: 'IC_1', body, createdAt: '2026-08-11T12:00:00Z' },
                    { id: 'IC_2', body, createdAt: '2026-08-12T12:00:00Z' },
                  ],
                  pageInfo: { hasPreviousPage: false, startCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
      connection: 'comments',
    }, stub.context));
    expect(result).toMatchObject({
      kind: 'comments',
      omittedRowCount: 1,
      projectionTruncated: true,
    });
    if (result.kind !== 'comments') throw new Error('the feedback read must settle as comments');
    expect(result.rows).toHaveLength(1);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
  });

  it('routes an issue Comments window through that same GraphQL feedback fetcher', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 4210, full_name: 'octo-org/example-app' });
        }
        if (pathname !== '/graphql') return undefined;
        const body = readRecordedJsonBody(request) as {
          query: string;
          variables: Record<string, unknown>;
        };
        expect(body.query).toContain('issue(number: $number)');
        expect(body.query).not.toContain('pullRequest(number: $number)');
        expect(body.variables).toMatchObject({
          owner: 'octo-org',
          name: 'example-app',
          number: 1284,
          commentCount: 40,
          commentCursor: null,
        });
        return jsonResponse({
          data: {
            repository: {
              databaseId: 4210,
              issue: {
                comments: {
                  nodes: [{
                    id: 'IC_3',
                    author: { login: 'latest' },
                    body: 'latest issue reply',
                    createdAt: '2026-08-13T12:00:00Z',
                    url: 'https://github.com/o/r/issues/1284#issuecomment-3',
                  }],
                  pageInfo: { hasPreviousPage: true, startCursor: 'issue-comments-before' },
                },
              },
            },
          },
        });
      },
    });

    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({
      v: 1,
      instance: configuredInstance(),
      localRef: ISSUE_REF,
      routingToken: REPOSITORY_KEY,
      connection: 'comments',
    }, stub.context));

    expect(result).toMatchObject({
      kind: 'comments',
      previousCursor: 'issue-comments-before',
      rows: [{ id: 'IC_3', body: 'latest issue reply' }],
    });
  });
});

/* ----------------------------------------------------------------------- checks */

function checksTransport(input: Readonly<{
  checkRuns?: StubHttpResponse;
  status?: StubHttpResponse;
  pullRequest?: StubHttpResponse;
}>) {
  return createStubGithubTransport({
    respond: (request): StubHttpResponse | undefined => {
      if (request.url.endsWith('/pulls/1284')) {
        return input.pullRequest ?? jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      }
      if (new URL(request.url).pathname !== '/graphql') return undefined;
      // GitHub's head rollup lists the same check runs and commit statuses the REST
      // collections hold; the fixtures are stated once, as REST bodies.
      const failed = [input.checkRuns, input.status].find((response) => response !== undefined && response.status !== 200);
      if (failed !== undefined) return failed;
      const { variables } = readRecordedJsonBody(request) as { variables: Record<string, unknown> };
      const upper = (value: unknown) => typeof value === 'string' ? value.toUpperCase() : null;
      const runs = ((input.checkRuns?.body as { check_runs?: readonly Record<string, unknown>[] } | undefined)?.check_runs ?? [])
        .map((run) => {
          const output = run.output as Readonly<Record<string, unknown>> | undefined;
          return { __typename: 'CheckRun', id: String(run.id), databaseId: run.id, name: run.name,
            status: upper(run.status), conclusion: upper(run.conclusion), detailsUrl: run.details_url,
            startedAt: run.started_at, completedAt: run.completed_at, isRequired: false,
            ...(variables.includeOutput === true ? { title: output?.title ?? null, summary: output?.summary ?? null,
              text: output?.text ?? null } : {}) };
        });
      const statuses = ((input.status?.body as { statuses?: readonly Record<string, unknown>[] } | undefined)?.statuses ?? [])
        .map((status) => ({ __typename: 'StatusContext', id: String(status.id), context: status.context,
          state: upper(status.state), targetUrl: status.target_url, createdAt: status.created_at,
          updatedAt: status.updated_at, isRequired: false,
          ...(variables.includeOutput === true ? { description: status.description ?? null } : {}) }));
      const nodes = [...runs, ...statuses];
      return jsonResponse({ data: { repository: { pullRequest: { headRefOid: HEAD_SHA, commits: { nodes: [{ commit: {
        oid: HEAD_SHA, statusCheckRollup: nodes.length === 0 ? null : { contexts: { nodes, pageInfo: { hasNextPage: false } } },
      } }] } } } } });
    },
  });
}

function checksInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    ...overrides,
  };
}

describe('GitHub checks plane', () => {
  it('reads check runs and commit statuses at the pull request current head revision', async () => {
    const stub = checksTransport({
      checkRuns: jsonResponse(githubCheckRunsResponse({
        runs: [
          githubCheckRun({ id: 9001, name: 'build', status: 'completed', conclusion: 'failure',
            output: { title: 'Build failed', summary: 'Typecheck found 2 errors.', text: 'Failing step: Compile\nTS2322 in src/main.ts' },
          }),
          githubCheckRun({ id: 9002, name: 'build', status: 'in_progress' }),
        ],
      })),
      status: jsonResponse(githubCombinedStatusResponse({
        state: 'success',
        statuses: [{ ...githubCommitStatus({ id: 7701, context: 'legacy/ci', state: 'success' }), description: 'Legacy build completed.' }],
      })),
    });

    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    if (result.kind !== 'checks') throw new Error('the checks read must settle as checks');
    // Reading against a remembered revision would answer for a commit the pull
    // request has already moved past.
    expect(result.headRevision).toBe(HEAD_SHA);
    // One head rollup read carries both the check runs and the commit statuses.
    expect(stub.requests.map((request) => new URL(request.url).pathname).filter((path) => path === '/graphql')).toHaveLength(1);
    expect(stub.requests.filter((request) => request.url.includes(HEAD_SHA))).toHaveLength(0);
    // Matrix legs share a name and a details URL; the native id keeps them apart.
    expect(result.rows.map((row) => row.key)).toEqual([
      'github-check-run:9001',
      'github-check-run:9002',
      'github-commit-status:7701',
    ]);
    expect(result.state).toBe('resolved');
    expect(result.failingCount).toBe(1);
    expect(result.runningCount).toBe(1);
    expect(result.passingCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      conclusion: 'failure', startedAtMs: Date.parse('2026-08-12T18:00:00Z'),
      completedAtMs: Date.parse('2026-08-12T18:04:00Z'),
      detailsUrl: 'https://ci.example.com/octo-org/example-app/checks',
      logExcerpt: 'Build failed\n\nTypecheck found 2 errors.\n\nFailing step: Compile\nTS2322 in src/main.ts',
    });
    expect(result.rows[2]).toMatchObject({
      conclusion: 'success', startedAtMs: Date.parse('2026-08-12T18:00:00Z'),
      completedAtMs: Date.parse('2026-08-12T18:04:00Z'),
      detailsUrl: 'https://ci.example.com/octo-org/example-app/status', logExcerpt: 'Legacy build completed.',
    });
  });

  it('fits unbounded provider diagnostics through the canonical Action result envelope', async () => {
    const diagnostic = 'x'.repeat(
      Math.floor(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2) + 2_048,
    );
    const runs = [9001, 9002].map((id) => githubCheckRun({
      id,
      name: `job-${id}`,
      status: 'completed',
      conclusion: 'failure',
      output: { text: diagnostic },
    }));
    const stub = checksTransport({
      checkRuns: jsonResponse(githubCheckRunsResponse({ runs })),
    });

    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    if (result.kind !== 'checks') throw new Error('the checks read must settle as checks');
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.omittedRowCount).toBe(1);
    expect(result.projectionTruncated).toBe(true);
  });

  it('states an unreadable rollup as unknown, never as counts nobody could compute', async () => {
    const stub = checksTransport({
      checkRuns: { status: 500, headers: {}, body: { message: 'server error' } },
      status: jsonResponse(githubCombinedStatusResponse({
        state: 'success',
        statuses: [githubCommitStatus({ id: 7701, context: 'legacy/ci', state: 'success' })],
      })),
    });

    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    if (result.kind !== 'checks') throw new Error('a partial checks read still settles');
    expect(result.rows).toEqual([]);
    expect(result.state).toBe('unknown');
    expect(result.checkRunsFailure).toEqual({ class: 'transient', code: 'github_server_error' });
    expect(result.commitStatusFailure).toBeUndefined();
    // A rendered `0 failing` on a suite nobody could read is a fabricated fact.
    expect(result.failingCount).toBeUndefined();
    expect(result.passingCount).toBeUndefined();
  });

  it('distinguishes a suite with nothing configured from one it could not read', async () => {
    const none = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), checksTransport({}).context),
    );
    if (none.kind !== 'checks') throw new Error('an empty suite still settles');
    expect(none.state).toBe('none');
    expect(none.rows).toEqual([]);
    expect(none.failingCount).toBeUndefined();

    const unreadable = GithubChecksResultV1Schema.parse(await readGithubChecks(
      checksInput(),
      checksTransport({
        checkRuns: { status: 500, headers: {}, body: { message: 'server error' } },
        status: { status: 500, headers: {}, body: { message: 'server error' } },
      }).context,
    ));
    if (unreadable.kind !== 'checks') throw new Error('an unreadable suite still settles');
    expect(unreadable.state).toBe('unknown');
  });

  it('states that it has no commit to ask about rather than reporting no checks', async () => {
    const stub = checksTransport({
      pullRequest: jsonResponse(Object.freeze({
        ...GITHUB_PULL_REQUEST_RESPONSE,
        head: Object.freeze({ label: 'octo-org:frame-pump', ref: 'frame-pump' }),
      })),
    });

    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_head_revision_unreadable' },
    });
    // The two check reads are never issued against a revision this source
    // could not establish.
    expect(stub.requests.filter((request) => request.url.includes('/pulls/1284'))).toHaveLength(1);
  });

  it('proves repository identity once, from the pull request it reads anyway, before any check read', async () => {
    const stub = checksTransport({});
    const result = GithubChecksResultV1Schema.parse(await readGithubChecks(checksInput(), stub.context));
    expect(result.kind).toBe('checks');
    const paths = stub.requests.map((request) => new URL(request.url).pathname);
    // No separate repository read: the pull request body carries the numeric id.
    expect(paths.filter((path) => path === `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`)).toEqual([]);
    expect(paths.filter((path) => path.endsWith('/pulls/1284'))).toHaveLength(1);
    expect(paths).toHaveLength(2);
  });

  it('stops before reading checks when the route now names another repository', async () => {
    const stub = checksTransport({ pullRequest: jsonResponse(Object.freeze({ ...GITHUB_PULL_REQUEST_RESPONSE,
      base: Object.freeze({ ...GITHUB_PULL_REQUEST_RESPONSE.base,
        repo: Object.freeze({ ...GITHUB_PULL_REQUEST_RESPONSE.base.repo, id: 999_999 }) }) })) });
    const result = GithubChecksResultV1Schema.parse(await readGithubChecks(checksInput(), stub.context));
    expect(result).toMatchObject({ kind: 'unavailable', failure: { code: 'route-body-mismatch' } });
    expect(stub.requests.filter((request) => request.url.includes(HEAD_SHA))).toEqual([]);
  });

  it('refuses a pull-request body that answers for another entry', async () => {
    const stub = checksTransport({
      pullRequest: jsonResponse(Object.freeze({ ...GITHUB_PULL_REQUEST_RESPONSE, number: 99 })),
    });
    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    // The canonical pull-request reader answers for exactly this entry or not at all.
    expect(result).toEqual({ kind: 'unavailable', failure: { class: 'unknown', code: 'route-body-mismatch' } });
    expect(stub.requests.filter((request) => request.url.includes(HEAD_SHA))).toEqual([]);
  });
});

describe('GitHub pull-request status operation', () => {
  it('retains current-head D-I14 fix evidence without fetching thread bodies or another snapshot', async () => {
    const stub = statusTransport(undefined, {
      reviewThreads: { nodes: [{ id: 'PRRT_resolved', isResolved: true }, { id: 'PRRT_open', isResolved: false }],
        pageInfo: { hasPreviousPage: false } },
      mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED',
      commits: { nodes: [{ commit: { oid: HEAD_SHA, statusCheckRollup: { contexts: {
        nodes: [
          { __typename: 'StatusContext', id: 'failed-required', context: 'Required failed', isRequired: true, state: 'FAILURE' },
          { __typename: 'StatusContext', id: 'pending-required', context: 'Required pending', isRequired: true, state: 'PENDING' },
          { __typename: 'StatusContext', id: 'failed-optional', context: 'Optional failed', isRequired: false, state: 'FAILURE' },
        ], pageInfo: { hasNextPage: false },
      } } } }] },
    }, undefined, undefined, { mergeable: false, mergeable_state: 'dirty' });
    const status = TriagePullRequestStatusResultV1Schema.parse(await readGithubPullRequestStatus(statusInput(), stub.context));
    expect(status).toMatchObject({ kind: 'status', branch: { headRevision: HEAD_SHA },
      review: { decision: 'changesRequested', threads: { rows: [
        { id: 'PRRT_resolved', isResolved: true }, { id: 'PRRT_open', isResolved: false },
      ], incomplete: false } }, merge: { conflicts: true }, checks: { rows: [
        { id: 'github-commit-status:failed-required', state: 'failed', required: true },
        { id: 'github-commit-status:pending-required', state: 'pending', required: true },
        { id: 'github-commit-status:failed-optional', state: 'failed', required: false },
      ] } });
    expect(stub.requests).toHaveLength(2);
    const query = stub.requests.find(request => new URL(request.url).pathname === '/graphql');
    expect(readRecordedJsonBody(query!)).toMatchObject({ query: expect.stringContaining('reviewThreads') });
    expect((readRecordedJsonBody(query!) as { query: string }).query).not.toMatch(/\bbody\b/u);
  });

  it.each([
    { nodes: [], pageInfo: { hasPreviousPage: true } },
    { nodes: [{ id: 'PRRT_unknown', isResolved: null }], pageInfo: { hasPreviousPage: false } },
    null,
  ])('keeps absent, malformed and windowed thread resolution unknown', async (reviewThreads) => {
    const stub = statusTransport(undefined, { reviewThreads, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' });
    expect(await readGithubPullRequestStatus(statusInput(), stub.context)).toMatchObject({ kind: 'status',
      review: { threads: { rows: [], incomplete: true } }, merge: { conflicts: false } });
  });

  it('retains denied thread evidence without calling it resolved and discards superseded thread rows', async () => {
    const reviewThreads = { nodes: [{ id: 'PRRT_open', isResolved: false }], pageInfo: { hasPreviousPage: false } };
    const denied = statusTransport(undefined, { reviewThreads }, [{ type: 'FORBIDDEN', message: 'Not permitted',
      path: ['repository', 'pullRequest', 'reviewThreads'] }]);
    expect(await readGithubPullRequestStatus(statusInput(), denied.context)).toMatchObject({ kind: 'status',
      review: { decision: 'changesRequested', threads: { rows: [{ id: 'PRRT_open', isResolved: false }], incomplete: true,
        failure: { class: 'permission' } } }, checks: { rows: expect.arrayContaining([
          expect.objectContaining({ id: 'github-check-run:9002', state: 'pending', required: true }),
        ]) } });
    const superseded = statusTransport(undefined, { reviewThreads, headRefOid: 'b'.repeat(40), mergeStateStatus: 'DIRTY' });
    expect(await readGithubPullRequestStatus(statusInput(), superseded.context)).toMatchObject({ kind: 'status',
      branch: { headRevision: 'b'.repeat(40) }, review: { threads: { rows: [], incomplete: true } },
      merge: { conflicts: null } });
  });

  it.each([
    { detailsUrl: 'https://ci.example.com/runs/7', targetUrl: 'https://legacy.example.com/build/9', available: true },
    { detailsUrl: null, targetUrl: undefined, available: false },
    { detailsUrl: 'javascript:alert(1)', targetUrl: 'https://user:secret@example.com/build', available: false },
    { detailsUrl: `https://ci.example.com/${'x'.repeat(MAX_TRIAGE_LOCATION_UTF8_BYTES_V1)}`, targetUrl: '/relative/build', available: false },
  ])('retains only supplied usable readiness destinations (available=$available)', async ({ detailsUrl, targetUrl, available }) => {
    const sourceUrl = `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pull/1284`;
    const stub = statusTransport(undefined, {
      commits: { nodes: [{ commit: { oid: HEAD_SHA, statusCheckRollup: { contexts: {
        nodes: [
          { __typename: 'CheckRun', id: 'url-check', name: 'CI', isRequired: true, status: 'COMPLETED',
            conclusion: 'FAILURE', detailsUrl, startedAt: '2026-08-31T10:00:00Z' },
          { __typename: 'StatusContext', id: 'url-status', context: 'Legacy', isRequired: false,
            state: 'SUCCESS', targetUrl, createdAt: '2026-08-31T10:00:00Z' },
        ], pageInfo: { hasNextPage: false },
      } } } }] },
    }, undefined, undefined, { html_url: available ? sourceUrl : null });
    const overview = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
    }, stub.context));
    if (overview.kind !== 'overview' || overview.kindId !== 'pull-request' || !overview.pullRequestStatus?.checks) {
      throw new Error('the retained Overview must expose admitted native status');
    }
    const status = overview.pullRequestStatus;
    if (available) {
      expect(status).toMatchObject({ sourceUrl, checks: { rows: [
        { id: 'github-check-run:url-check', detailsUrl }, { id: 'github-commit-status:url-status', detailsUrl: targetUrl },
      ] } });
    } else {
      expect(Object.hasOwn(status, 'sourceUrl')).toBe(false);
      expect(status.checks!.rows.every((row) => !Object.hasOwn(row, 'detailsUrl'))).toBe(true);
    }
    expect(stub.requests.map((request) => new URL(request.url).pathname).sort()).toEqual([
      '/graphql', `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`,
    ].sort());
  });

  function statusInput(localRef: Readonly<{ kindId: string; collisionScope: string; entryId: string }> = PULL_REQUEST_REF) {
    return {
      v: 1, instance: configuredInstance(), localRef,
      lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY, displayPath: '#1284' },
    };
  }

  function statusTransport(checkRuns?: StubHttpResponse, native: Readonly<Record<string, unknown>> = {}, errors?: readonly unknown[],
    rules?: (request: RecordedGithubRequest) => StubHttpResponse, rest: Readonly<Record<string, unknown>> = {},
    repository: Readonly<Record<string, unknown>> = {}, responseHeaders: Readonly<Record<string, string>> = {}) {
    return createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse({
        ...GITHUB_PULL_REQUEST_RESPONSE, mergeable: true, mergeable_state: 'blocked',
        additions: 18, deletions: 3, ...rest,
      }, responseHeaders);
      if (path.includes('/check-runs')) return checkRuns ?? jsonResponse(githubCheckRunsResponse({ runs: [
        githubCheckRun({ id: 9001, name: 'build', status: 'completed', conclusion: 'failure' }),
        githubCheckRun({ id: 9002, name: 'test', status: 'in_progress' }),
      ] }));
      if (path.endsWith('/status')) return jsonResponse(githubCombinedStatusResponse({
        state: 'success', statuses: [githubCommitStatus({ id: 7701, context: 'legacy/ci', state: 'success' })],
      }));
      if (path.includes('/rules/branches/')) return rules?.(request) ?? jsonResponse([]);
      if (path !== '/graphql') return undefined;
      const body = readRecordedJsonBody(request) as { query: string; variables?: Record<string, unknown> };
      if (body.query.includes('query Checks')) {
        // GitHub answers `@include(if: $includeOutput)` fields only when the query asks.
        const output = (run: ReturnType<typeof githubCheckRun>) => {
          if (body.variables?.includeOutput !== true) return {};
          const native = (run as { output?: Readonly<Record<string, unknown>> }).output;
          return { title: native?.title ?? null, summary: native?.summary ?? null, text: native?.text ?? null };
        };
        if (checkRuns && checkRuns.status !== 200) return checkRuns;
        const source = checkRuns?.body as { check_runs?: readonly ReturnType<typeof githubCheckRun>[] } | undefined;
        const runs = source?.check_runs ?? [
          githubCheckRun({ id: 9001, name: 'build', status: 'completed', conclusion: 'failure' }),
          githubCheckRun({ id: 9002, name: 'test', status: 'in_progress' }),
        ];
        return jsonResponse({ data: { repository: { ...repository, pullRequest: {
          id: 'PR_1284', headRefOid: HEAD_SHA, reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED',
          viewerCanMergeAsAdmin: true, viewerCanUpdate: true,
          viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: false,
          mergeQueueEntry: null,
          reviews: { nodes: [
            { id: 'PRR_1', state: 'APPROVED', author: { login: 'alice' }, submittedAt: '2026-08-11T12:00:00Z' },
            { id: 'PRR_2', state: 'CHANGES_REQUESTED', author: { login: 'alice' }, submittedAt: '2026-08-12T12:00:00Z' },
            { id: 'PRR_3', state: 'COMMENTED', author: { login: 'alice' }, submittedAt: null },
          ], pageInfo: { hasPreviousPage: true } },
          reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'bob' } }],
            pageInfo: { hasNextPage: false } },
          commits: { nodes: [{ commit: { oid: HEAD_SHA, statusCheckRollup: { contexts: {
            nodes: [
              ...runs.map((run) => ({ __typename: 'CheckRun', id: String(run.id), name: run.name,
                isRequired: run.id === 9002, status: typeof run.status === 'string' ? run.status.toUpperCase() : '',
                conclusion: typeof run.conclusion === 'string' ? run.conclusion.toUpperCase() : null,
                startedAt: '2026-08-31T10:00:00Z', ...output(run) })),
              { __typename: 'StatusContext', id: '7701', context: 'legacy/ci', state: 'SUCCESS',
                isRequired: true, createdAt: '2026-08-31T10:00:00Z', updatedAt: '2026-08-31T10:01:00Z' },
            ], pageInfo: { hasNextPage: false },
          } } } }] }, ...native,
        } } }, ...(errors === undefined ? {} : { errors }) });
      }
      return jsonResponse({ data: { repository: { databaseId: 4210, pullRequest: body.query.includes('GithubFeedbackReviews')
        ? { reviewDecision: 'CHANGES_REQUESTED', reviews: {
          nodes: [
            { id: 'PRR_1', state: 'APPROVED', body: '', author: { login: 'alice' }, submittedAt: '2026-08-11T12:00:00Z' },
            { id: 'PRR_2', state: 'CHANGES_REQUESTED', body: '', author: { login: 'alice' }, submittedAt: '2026-08-12T12:00:00Z' },
            { id: 'PRR_3', state: 'COMMENTED', body: '', author: { login: 'alice' }, submittedAt: null },
          ], pageInfo: { hasPreviousPage: true, startCursor: 'older-reviews' },
        } }
        : { reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'bob' } }],
          pageInfo: { hasNextPage: false, endCursor: null } } },
      } } });
    } });
  }

  it.each<{ headers: Readonly<Record<string, string>>; expected: number }>([
    { headers: { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '1788171672' }, expected: 60_000 },
    { headers: { 'x-poll-interval': '120' }, expected: 120_000 },
  ])('derives the native refresh hint from the same read response: $expected ms', async ({ headers, expected }) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T10:11:12Z'));
    try {
      const stub = statusTransport(undefined, {}, undefined, undefined, {}, {}, headers);
      expect(await readGithubPullRequestStatus(statusInput(), stub.context)).toMatchObject({ kind: 'status', refreshAfterMs: expected });
      expect(stub.requests).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });

  it.each([false, true])('omits the native refresh hint for a terminal PR (merged: %s)', async merged => {
    const stub = statusTransport(undefined, {}, undefined, undefined, { state: 'closed', merged }, {}, { 'x-poll-interval': '120' });
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result.kind).toBe('status');
    expect(result).not.toHaveProperty('refreshAfterMs');
    expect(stub.requests).toHaveLength(2);
  });

  it.each([
    { archived: false, hasIssues: false, merge: true, squash: false, rebase: true },
    { archived: true, hasIssues: true, merge: false, squash: true, rebase: false },
    { archived: false, hasIssues: true, merge: false, squash: true, rebase: false },
  ])('projects every repository capability from the existing Overview summary with exact REST parity: %j', async shape => {
    const repository = { id: 4210, full_name: REPOSITORY_KEY, archived: shape.archived, has_issues: shape.hasIssues,
      allow_merge_commit: shape.merge, allow_squash_merge: shape.squash, allow_rebase_merge: shape.rebase };
    const capTransport = createStubGithubTransport({ respond: () => jsonResponse(repository) });
    const request = { v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY };
    const expected = GithubCapabilitiesResultV1Schema.parse(await readGithubCapabilities(request, capTransport.context));
    const stub = statusTransport(undefined, {}, undefined, undefined, { mergeable_state: 'behind' }, {
      isArchived: shape.archived, hasIssuesEnabled: shape.hasIssues,
      mergeCommitAllowed: shape.merge, squashMergeAllowed: shape.squash, rebaseMergeAllowed: shape.rebase,
    });
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview(request, stub.context));
    expect(result).toHaveProperty('capabilities', expected);
    expect(result).toMatchObject({ kind: 'overview', kindId: 'pull-request', mergeableState: 'behind' });
    expect(stub.requests).toHaveLength(2); // Retained REST PR + the existing summary/checks query.
    expect(readRecordedJsonBody(stub.requests.find(request => new URL(request.url).pathname === '/graphql')!))
      .toMatchObject({ query: expect.stringContaining('hasIssuesEnabled') });
  });

  it('states the detail checks, with each check output, from the Overview read itself', async () => {
    // One owner per fact: the Overview's PR read and its rollup query are the detail's checks.
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9001, name: 'build', status: 'completed', conclusion: 'failure',
        output: { title: 'Typecheck failed', summary: '2 errors in src/pump.ts' } }),
      githubCheckRun({ id: 9002, name: 'test', status: 'in_progress' }),
    ] })));
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
    }, stub.context));
    expect(result).toMatchObject({ kind: 'overview', kindId: 'pull-request', checks: {
      headRevision: HEAD_SHA, state: 'resolved', rowState: { kind: 'failing', failingCount: 1 },
      rows: [
        { key: 'github-check-run:9001', name: 'build', conclusion: 'failure', logExcerpt: 'Typecheck failed\n\n2 errors in src/pump.ts' },
        { key: 'github-check-run:9002', name: 'test', status: 'in_progress' },
        { key: 'github-commit-status:7701', name: 'legacy/ci' },
      ],
    } });
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(stub.requests.map((request) => new URL(request.url).pathname))
      .toEqual([`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`, '/graphql']);
  });

  it('answers agents with exactly the checks the Overview states, from the same rollup read', async () => {
    // One canonical checks reader: the Checks Action and the Overview use the same query,
    // outcome mapping and identity proof, so an agent sees what the detail shows.
    const runs = jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9001, name: 'build', status: 'completed', conclusion: 'failure',
        output: { title: 'Typecheck failed', summary: '2 errors in src/pump.ts' } }),
      githubCheckRun({ id: 9002, name: 'test', status: 'in_progress' }),
    ] }));
    const overview = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
    }, statusTransport(runs).context));
    const stub = statusTransport(runs);
    const checks = GithubChecksResultV1Schema.parse(await readGithubChecks({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
    }, stub.context));
    if (overview.kind !== 'overview' || overview.kindId !== 'pull-request') throw new Error('expected a PR overview');
    const { kind, ...view } = checks;
    expect(kind).toBe('checks');
    expect(view).toEqual(overview.checks);
    expect(stub.requests.map((request) => new URL(request.url).pathname))
      .toEqual([`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`, '/graphql']);
  });

  it('publishes portable original merge offers from the same admitted native acquisition', async () => {
    const stub = statusTransport(undefined, { mergeStateStatus: 'CLEAN' }, undefined, undefined,
      { auto_merge: null }, { isArchived: false, mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: true });
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', operations: {
      primary: { id: 'merge', disabledReason: expect.any(String),
        actionRef: { pluginId: GITHUB_PLUGIN_ID, localId: 'github/pull-request/merge' },
        variants: [
          { id: 'merge', method: expect.any(Object), input: { instance: configuredInstance(), localRef: PULL_REQUEST_REF,
            routingToken: REPOSITORY_KEY, headRevision: HEAD_SHA, mergeMethod: 'merge' } },
          { id: 'rebase', method: expect.any(Object), input: { mergeMethod: 'rebase', headRevision: HEAD_SHA } },
        ] },
    } });
    expect(stub.requests.filter(request => new URL(request.url).pathname === '/graphql')).toHaveLength(1);
    expect(stub.requests.filter(request => new URL(request.url).pathname.endsWith('/pulls/1284'))).toHaveLength(1);
    expect(stub.requests).toHaveLength(2);
    const query = readRecordedJsonBody(stub.requests.find(request => new URL(request.url).pathname === '/graphql')!);
    expect(query).toMatchObject({ query: expect.stringContaining('mergeCommitAllowed') });
    expect(query).toMatchObject({ query: expect.stringContaining('squashMergeAllowed') });
    expect(query).toMatchObject({ query: expect.stringContaining('rebaseMergeAllowed') });
  });

  it.each([
    { queue: null, required: true, expected: 'enqueue', auto: false, alternative: 'enableAutoMerge' },
    { queue: { id: 'queue-entry', state: 'QUEUED', position: 2 }, required: false, expected: 'dequeue', auto: true, alternative: 'cancelAutoMerge' },
  ])('forwards native $expected and $alternative as exact original Actions', async ({ queue, required, expected, auto, alternative }) => {
    const stub = statusTransport(undefined, { mergeQueueEntry: queue, viewerCanDisableAutoMerge: auto }, undefined,
      () => jsonResponse(required ? [{ type: 'merge_queue' }] : []),
      { auto_merge: auto ? { merge_method: 'squash' } : null },
      { isArchived: false, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
    const result = await readGithubOverview({ v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY, includeBranchRules: required }, stub.context);
    expect(result).toMatchObject({ kind: 'overview', pullRequestStatus: { operations: {
      primary: { id: expected, actionRef: { pluginId: GITHUB_PLUGIN_ID,
        localId: `github/pull-request/${expected}` }, variants: [{ input: {
          instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
          ...(expected === 'enqueue' ? { expectedHeadSha: HEAD_SHA } : {}),
        } }] },
      alternatives: expect.arrayContaining([{ id: alternative, title: expect.any(String), titleKey: expect.any(String),
        disabledReason: null, actionRef: { pluginId: GITHUB_PLUGIN_ID, localId: 'github/pull-request/auto-merge-set' },
        variants: expect.arrayContaining([{ id: auto ? 'cancelAutoMerge' : 'merge', ...(auto ? {} : { method: expect.any(Object) }),
          input: expect.objectContaining({ enabled: !auto, expectedHeadSha: HEAD_SHA }) }]),
      }]),
    } } });
  });

  it('never guesses methods or retains offers across an observed head change', async () => {
    const unknown = await readGithubPullRequestStatus(statusInput(), statusTransport().context);
    expect(unknown).toMatchObject({ kind: 'status', operations: { primary: { variants: [], disabledReason: expect.any(String) } } });
    const changed = await readGithubPullRequestStatus(statusInput(), statusTransport(undefined,
      { headRefOid: 'b'.repeat(40) }, undefined, undefined, {}, { mergeCommitAllowed: true }).context);
    expect(changed.kind).toBe('status');
    expect(Object.hasOwn(changed, 'operations')).toBe(false);
  });

  it('retains exact admitted native operands when only the branch display is unavailable', async () => {
    const stub = statusTransport(undefined, { mergeStateStatus: 'CLEAN',
      mergeQueueEntry: { id: 'queue-entry', state: 'QUEUED', position: 2 }, viewerCanDisableAutoMerge: true,
    }, undefined, undefined, { head: { sha: HEAD_SHA, ref: null }, auto_merge: { merge_method: 'squash' } },
    { isArchived: false, mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false });
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', branch: { headRevision: HEAD_SHA, base: 'main' }, operations: {
      primary: { id: 'dequeue', disabledReason: null, variants: [{ id: 'dequeue', input: {
        instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
      } }] },
      alternatives: expect.arrayContaining([expect.objectContaining({ id: 'cancelAutoMerge', disabledReason: null,
        variants: [{ id: 'cancelAutoMerge', input: expect.objectContaining({ enabled: false, expectedHeadSha: HEAD_SHA }) }],
      })]),
    } });
    expect(stub.requests).toHaveLength(2);
  });

  it('offers only the exact acknowledged without-waiting operands for complete native scope', async () => {
    const stub = statusTransport(undefined, { mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
      reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
    }, undefined, undefined, {}, { isArchived: false, mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false });
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', operations: { alternatives: [
      { id: 'withoutWaiting', variants: [{ id: 'squash', method: expect.any(Object), input: {
        headRevision: HEAD_SHA, mergeMethod: 'squash', intent: 'withoutWaiting',
        skippedRequirements: [{ kind: 'check', id: 'github-check-run:9002', label: 'test' }],
      } }] },
    ] } });
    expect(stub.requests).toHaveLength(2);
  });

  it('reads detail status at the current head and fills the canonical review/check facts', async () => {
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9001, name: 'x'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 + 1), status: 'completed', conclusion: 'failure' }),
      githubCheckRun({ id: 9002, name: 'test', status: 'in_progress' }),
    ] })));
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({
      kind: 'status',
      title: GITHUB_PULL_REQUEST_RESPONSE.title,
      projectionTruncated: true,
      checks: { state: 'complete', passed: 1, failed: 1, pending: 1, total: 3, incomplete: false,
        rows: [{ id: 'github-check-run:9001', name: 'x'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1), state: 'failed', required: false }, { id: 'github-check-run:9002', state: 'pending', required: true },
          { id: 'github-commit-status:7701', state: 'passed', required: true }] },
      review: { decision: 'changesRequested', reviewers: [{ id: 'user:alice', name: 'alice', verb: 'changesRequested' },
        { id: 'user:bob', name: 'bob', verb: 'pending' }], incomplete: true },
      merge: { state: 'blocked', nativeState: 'BLOCKED', canMergeWithoutWaiting: true },
      branch: { head: 'frame-pump', base: 'main', headRevision: HEAD_SHA, additions: 18, deletions: 3 },
      facts: [
        { id: 'github/review-decision', value: { kind: 'status', value: 'Changes requested', tone: 'danger' } },
        { id: 'github/checks', value: { kind: 'status', value: '1 failing', tone: 'danger' } },
      ],
    });
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(stub.requests.filter((request) => new URL(request.url).pathname.endsWith('/pulls/1284'))).toHaveLength(1);
    expect(stub.requests.filter((request) => request.url.includes(HEAD_SHA))).toHaveLength(0);
    expect(stub.requests.filter((request) => new URL(request.url).pathname === '/graphql')).toHaveLength(1);
  });

  it('preserves successful rows while keeping an unreadable check breakdown unknown', async () => {
    const stub = statusTransport({ status: 500, headers: {}, body: { message: 'failed' } });
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', checks: {
      state: 'unknown', passed: null, failed: null, pending: null, total: null, incomplete: true,
      rows: [], failure: { class: 'transient', code: 'github_server_error' },
    }, merge: { state: 'blocked', blocker: 'Blocked on GitHub' } });
    if (result.kind !== 'status') throw new Error('partial status must keep the observed detail');
    expect(result.facts.some((fact) => fact.id === 'github/checks')).toBe(false);
  });

  it('fails credential revocation during the fresh rollup instead of treating it as unknown policy', async () => {
    const stub = statusTransport({ status: 401, body: { message: 'Bad credentials' } });
    expect(await readGithubPullRequestStatus(statusInput(), stub.context)).toEqual({
      kind: 'unavailable', failure: { class: 'authentication', code: 'github_unauthorized' },
    });
    expect(await readGithubOverview({ v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY }, stub.context)).toEqual({
      kind: 'unavailable', failure: { class: 'authentication', code: 'github_unauthorized' },
    });
  });

  it.each([
    ['CLEAN', 'mergeable'], ['HAS_HOOKS', 'mergeable'], ['UNSTABLE', 'mergeable'],
    ['BLOCKED', 'blocked'], ['DIRTY', 'conflicts'], ['DRAFT', 'blocked'],
    ['BEHIND', 'unknown'], ['UNKNOWN', 'unknown'], ['FUTURE_NATIVE_STATE', 'unknown'],
  ])('preserves native %s without confusing conflict freedom with readiness', async (nativeState, state) => {
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9001, name: 'Optional failure', status: 'completed', conclusion: 'failure' }),
    ] })), { mergeStateStatus: nativeState, reviewDecision: 'APPROVED' }, undefined, undefined, { mergeable_state: 'clean' });
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', merge: { nativeState, state } });
  });

  it.each(['CLEAN', 'UNSTABLE'])('keeps required checks and reviews blocked despite native %s', async (nativeState) => {
    const stub = statusTransport(undefined, { mergeStateStatus: nativeState });
    expect(await readGithubPullRequestStatus(statusInput(), stub.context)).toMatchObject({
      kind: 'status', merge: { state: 'blocked', nativeState, blocker: expect.any(String) },
    });
  });

  it.each(['UNKNOWN', 'FUTURE_NATIVE_STATE', undefined])('retains a known REST block with native %s', async (nativeState) => {
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [] })),
      { mergeStateStatus: nativeState, reviewDecision: 'APPROVED' });
    expect(await readGithubPullRequestStatus(statusInput(), stub.context)).toMatchObject({
      kind: 'status', merge: { state: 'blocked', blocker: 'Blocked on GitHub' },
    });
  });

  it('keeps draft blocked even when REST says conflict free and retains native auto-merge', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE,
        draft: true, mergeable: true, auto_merge: { merge_method: 'squash' } });
      if (path === '/graphql') return jsonResponse({ data: { repository: { pullRequest: {
        headRefOid: HEAD_SHA, mergeStateStatus: 'CLEAN', viewerCanMergeAsAdmin: true,
        commits: { nodes: [{ commit: { oid: HEAD_SHA, statusCheckRollup: null } }] },
      } } } });
      return undefined;
    } });
    expect(await readGithubPullRequestStatus(statusInput(), stub.context)).toMatchObject({
      kind: 'status', merge: { state: 'blocked', draft: true, autoMerge: { enabled: true, method: 'squash' } },
    });
  });

  it('walks 201 native contexts once, retaining requiredness and one shared eligibility read', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      if (path !== '/graphql') return undefined;
      const body = readRecordedJsonBody(request) as { query: string; variables: { cursor: string | null } };
      const offset = body.variables.cursor === null ? 0 : Number(body.variables.cursor);
      return jsonResponse({ data: { repository: { pullRequest: {
        id: 'PR_1284', headRefOid: HEAD_SHA, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
        viewerCanMergeAsAdmin: true, mergeQueueEntry: null,
        commits: { nodes: [{ commit: { oid: HEAD_SHA, statusCheckRollup: { contexts: {
          nodes: Array.from({ length: Math.min(100, 201 - offset) }, (_, index) => ({
            __typename: 'CheckRun', id: `native-${offset + index}`, name: `Check ${offset + index}`,
            isRequired: index % 2 === 0, status: 'COMPLETED', conclusion: 'SUCCESS',
            startedAt: '2026-08-31T10:00:00Z',
          })), pageInfo: { hasNextPage: offset < 200, endCursor: String(offset + 100) },
        } } } }] },
      } } } });
    } });
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', checks: { state: 'complete', total: 201, incomplete: false } });
    if (result.kind !== 'status') throw new Error('status must be readable');
    expect(result.checks?.rows).toHaveLength(201);
    expect(result.checks?.rows.every((row) => typeof row.required === 'boolean')).toBe(true);
    expect(stub.requests.filter((request) => new URL(request.url).pathname === '/graphql')).toHaveLength(3);
    expect(stub.requests.filter((request) => /check-runs|\/status/u.test(new URL(request.url).pathname))).toHaveLength(0);
    expect(stub.requests.filter((request) => request.url.includes('/rules/branches/'))).toHaveLength(1);
    for (const request of stub.requests.filter((request) => new URL(request.url).pathname === '/graphql')) {
      expect(readRecordedJsonBody(request)).toMatchObject({ query: expect.stringContaining('viewerCanMergeAsAdmin') });
      expect((readRecordedJsonBody(request) as { query: string }).query).not.toMatch(/\bbody\b/u);
    }
    expect(stub.requests.filter((request) => new URL(request.url).pathname === '/graphql')
      .map((request) => (readRecordedJsonBody(request) as { variables: { includeSummary: boolean } }).variables.includeSummary))
      .toEqual([true, false, false]);
  });

  it.each(['FAILURE', 'SUCCESS'])('fits status rows inside the complete Overview envelope without another acquisition (%s)', async (conclusion) => {
    const name = '"'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
    const total = Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / (MAX_TRIAGE_TEXT_UTF8_BYTES_V1 * 2));
    const body = 'Context for the pull request.\n'.repeat(1_024);
    const stub = createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, body });
      if (path !== '/graphql') return undefined;
      const input = readRecordedJsonBody(request) as { variables: { cursor: string | null } };
      const start = input.variables.cursor === null ? 0 : Number(input.variables.cursor);
      const end = Math.min(start + 100, total);
      return jsonResponse({ data: { repository: {
        isArchived: false, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true,
        pullRequest: {
        id: 'PR_1284', headRefOid: HEAD_SHA, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', viewerCanMergeAsAdmin: true,
        reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
        reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
        reviewThreads: { nodes: [{ id: 'PRRT_envelope', isResolved: false }], pageInfo: { hasPreviousPage: false } },
        mergeQueueEntry: null,
        commits: { nodes: [{ commit: { oid: HEAD_SHA, statusCheckRollup: { contexts: {
          nodes: Array.from({ length: end - start }, (_, index) => ({
            __typename: 'CheckRun', id: `envelope-${start + index}`, name, isRequired: true,
            status: 'COMPLETED', conclusion: start + index === 0 ? conclusion : 'SUCCESS', startedAt: '2026-08-31T10:00:00Z',
          })), pageInfo: { hasNextPage: end < total, endCursor: String(end) },
        } } } }] },
      } } } });
    } });
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY,
    }, stub.context));
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(result).toMatchObject({ kind: 'overview', body, requiredChecks: { state: 'unknown' },
      pullRequestStatus: { projectionTruncated: true, checks: { total, passed: total - (conclusion === 'FAILURE' ? 1 : 0), failed: conclusion === 'FAILURE' ? 1 : 0, incomplete: true },
        review: { threads: { rows: [], incomplete: true } },
        operations: { alternatives: expect.not.arrayContaining([expect.objectContaining({ id: 'withoutWaiting' })]) } },
    });
    if (result.kind !== 'overview' || result.kindId !== 'pull-request' || !result.pullRequestStatus?.checks) {
      throw new Error('the complete Overview must retain its partial status');
    }
    const { pullRequestStatus: status } = result;
    if (conclusion === 'SUCCESS') {
      expect(status.operations?.readiness).toBe('ready');
      expect(projectPullRequestStatusFactsV1(status).merge.kind).toBe(status.operations?.readiness);
      const header = presentTriageMergeReadinessV1({ title: 'Merge', pending: false,
        disabledReason: status.operations?.primary.disabledReason ?? null,
        nativeStatus: { kind: 'current', value: status, checkedAtMs: status.observedAtMs },
        execute: async () => {},
      }, (_key, fallback) => fallback, (_key, count, words) => count === 1 ? words.one : words.other, 'GitHub');
      expect(header?.line?.words).toBe('Ready');
      expect(header?.line?.detail).toBe('{source} sent only part of it');
    }
    const checks = result.pullRequestStatus.checks;
    const rows = checks.rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(total);
    const next = { ...status, checks: { ...checks, rows: [...rows,
      { id: `github-check-run:envelope-${rows.length}`, name, state: 'passed' as const, required: true,
        startedAtMs: Date.parse('2026-08-31T10:00:00Z') },
    ] } };
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(next)).toBe(true);
    // The detail's checks view carries exactly the fitted status rows, so one more row is
    // one more row in both, and the walk already measured them together.
    const view = result.checks;
    if (view === undefined) throw new Error('the Overview must state its checks view');
    expect(view.rows).toHaveLength(rows.length);
    const nextView = { ...view, rows: [...view.rows, { ...view.rows.at(-1)!, key: `github-check-run:envelope-${rows.length}` }] };
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1({ ...result, pullRequestStatus: next, checks: nextView })).toBe(false);
    expect(stub.requests.filter((request) => new URL(request.url).pathname.endsWith('/pulls/1284'))).toHaveLength(1);
    expect(stub.requests.filter((request) => new URL(request.url).pathname === '/graphql')).toHaveLength(Math.ceil(total / 100));
    expect(stub.requests.filter((request) => /check-runs|\/status/u.test(new URL(request.url).pathname))).toHaveLength(0);
    expect(stub.requests.filter((request) => request.url.includes('/rules/branches/'))).toHaveLength(conclusion === 'SUCCESS' ? 1 : 0);
  });

  it('retains readable native blockers and rows across partial GraphQL errors', async () => {
    const stub = statusTransport(undefined, { viewerCanMergeAsAdmin: null }, [
      { type: 'FORBIDDEN', message: 'Resource not accessible', path: ['repository', 'pullRequest', 'viewerCanMergeAsAdmin'] },
    ]);
    expect(await readGithubPullRequestStatus(statusInput(), stub.context)).toMatchObject({ kind: 'status',
      checks: { state: 'unknown', incomplete: true, failure: { class: 'permission', code: 'github_forbidden' }, rows: [
        { id: 'github-check-run:9001', required: false }, { id: 'github-check-run:9002', required: true },
        { id: 'github-commit-status:7701', required: true },
      ] },
      merge: { state: 'blocked', nativeState: 'BLOCKED', canMergeWithoutWaiting: null },
    });
  });

  it('retires old-head native facts instead of using them for a fresh decision', async () => {
    const nextHead = 'b'.repeat(40);
    const stub = statusTransport(undefined, { headRefOid: nextHead });
    expect(await readGithubPullRequestStatus(statusInput(), stub.context)).toMatchObject({ kind: 'status',
      checks: { state: 'unknown', incomplete: true, rows: [] },
      review: { decision: null, incomplete: true },
      merge: { state: 'unknown', draft: null, autoMerge: null, canMergeWithoutWaiting: null }, branch: { headRevision: nextHead },
    });
  });

  it('retains a superseding native head when branch display labels are unavailable', async () => {
    const nextHead = 'b'.repeat(40);
    const stub = statusTransport(undefined, { headRefOid: nextHead }, undefined, undefined, {
      head: { ...(GITHUB_PULL_REQUEST_RESPONSE.head as Readonly<Record<string, unknown>>), sha: HEAD_SHA, ref: null },
      base: { ...(GITHUB_PULL_REQUEST_RESPONSE.base as Readonly<Record<string, unknown>>), sha: BASE_SHA, ref: null },
    });
    const result = TriagePullRequestStatusResultV1Schema.parse(await readGithubPullRequestStatus(statusInput(), stub.context));
    expect(result).toMatchObject({ kind: 'status', branch: { headRevision: nextHead },
      checks: { state: 'unknown', incomplete: true, rows: [] },
      merge: { state: 'unknown', canMergeWithoutWaiting: null },
    });
    if (result.kind !== 'status') throw new Error('expected native status');
    expect(result.branch).not.toHaveProperty('head');
    expect(result.branch).not.toHaveProperty('base');
    expect(result).not.toHaveProperty('operations');
    expect(stub.requests).toHaveLength(2);
  });

  it('reads a CLEAN pull request’s merge queue requirement before offering its primary write', async () => {
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9002, name: 'test', status: 'completed', conclusion: 'success' }),
    ] })), { mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
      reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
    }, undefined, () => jsonResponse([{ type: 'merge_queue', ruleset_id: 25795136 }]), {},
    { isArchived: false, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({ v: 1, instance: configuredInstance(),
      localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY }, stub.context));
    expect(result).toMatchObject({ kind: 'overview', pullRequestStatus: {
      merge: { queueRequired: true, state: 'blocked' },
      operations: { readiness: 'blocked', primary: { id: 'enqueue', disabledReason: null } },
    } });
    expect(stub.requests.filter(request => request.url.includes('/rules/branches/main'))).toHaveLength(1);
  });

  it.each(['status', 'overview'] as const)('preserves a typed authentication refusal from branch rules in %s', async plane => {
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9002, name: 'test', status: 'completed', conclusion: 'success' }),
    ] })), { mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }, undefined,
    () => ({ status: 401, body: { message: 'Bad credentials' } }));
    const result = plane === 'status'
      ? await readGithubPullRequestStatus(statusInput(), stub.context)
      : await readGithubOverview({ v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF,
        routingToken: REPOSITORY_KEY, includeBranchRules: true }, stub.context);
    expect(result).toEqual({ kind: 'unavailable', failure: { class: 'authentication', code: 'github_unauthorized' } });
    expect(stub.requests.filter(request => request.url.includes('/rules/branches/main'))).toHaveLength(1);
  });

  it('reads active base-branch rules on disclosure, pages them, and never labels checks by name', async () => {
    const stub = statusTransport(undefined, { mergeStateStatus: 'CLEAN' }, undefined, (request) =>
      new URL(request.url).searchParams.get('page') === '2'
        ? jsonResponse([{ type: 'required_status_checks', ruleset_id: 13,
          parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'not-an-emitted-check' }] } }])
        : jsonResponse([{ type: 'merge_queue', ruleset_id: 12 }], { link:
          `<https://api.github.com/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/rules/branches/main?per_page=100&page=2>; rel="next"` }));
    const input = { v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY };
    await readGithubOverview(input, stub.context);
    expect(stub.requests.filter((request) => request.url.includes('/rules/branches/'))).toHaveLength(0);
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({ ...input, includeBranchRules: true }, stub.context));
    expect(result).toMatchObject({ kind: 'overview', pullRequestStatus: { merge: {
      queueRequired: true, upToDateRequired: true, branchRules: { state: 'complete', rows: [
        { type: 'merge_queue', rulesetId: '12' }, { type: 'required_status_checks', rulesetId: '13' },
      ] },
    }, checks: { rows: [
      { id: 'github-check-run:9001', required: false }, { id: 'github-check-run:9002', required: true },
      { id: 'github-commit-status:7701', required: true },
    ] } } });
    expect(stub.requests.filter((request) => request.url.includes('/rules/branches/main'))).toHaveLength(2);
  });

  it.each([
    { response: jsonResponse([]), state: 'complete' },
    { response: { status: 403, body: { message: 'Resource not accessible' } }, state: 'unknown' },
  ])('keeps $state rule evidence from claiming an exemption', async ({ response, state }) => {
    const stub = statusTransport(undefined, { mergeStateStatus: 'CLEAN' }, undefined,
      () => response);
    const result = await readGithubOverview({ v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY, includeBranchRules: true }, stub.context);
    expect(result).toMatchObject({ kind: 'overview', pullRequestStatus: { merge: {
      queueRequired: null, upToDateRequired: null, branchRules: { state, rows: [] },
    } } });
  });

  it.each([
    { evidence: true, expected: true },
    { evidence: false, expected: false },
    { evidence: undefined, expected: null },
    { evidence: 'false', expected: null },
  ])('retains native review-thread-resolution evidence $evidence without implying its outcome', async ({ evidence, expected }) => {
    const stub = statusTransport(undefined, { mergeStateStatus: 'BLOCKED' }, undefined,
      () => jsonResponse([{ type: 'pull_request', ruleset_id: 42,
        ...(evidence === undefined ? {} : { parameters: { required_review_thread_resolution: evidence } }),
      }]));
    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1, instance: configuredInstance(), localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY, includeBranchRules: true,
    }, stub.context));
    expect(result).toMatchObject({ kind: 'overview', pullRequestStatus: { merge: {
      state: 'blocked', branchRules: { state: 'complete', rows: [
        { type: 'pull_request', rulesetId: '42', reviewThreadResolutionRequired: expected },
      ] },
    } } });
    expect(stub.requests.filter((request) => request.url.includes('/rules/branches/'))).toHaveLength(1);
    expect(stub.requests.filter((request) => new URL(request.url).pathname === '/graphql')).toHaveLength(1);
  });

  it('reports omitted normalized-empty names without discarding the known provider counts', async () => {
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9001, name: '\u0000', status: 'completed', conclusion: 'failure' }),
    ] })));
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', projectionTruncated: true, checks: {
      state: 'complete', passed: 1, failed: 1, pending: 0, total: 2, incomplete: true,
      rows: [{ id: 'github-commit-status:7701', state: 'passed' }],
    } });
  });

  it('refuses an issue before making provider requests', async () => {
    const stub = statusTransport();
    expect(await readGithubPullRequestStatus(statusInput(ISSUE_REF), stub.context)).toEqual({
      kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_detail_kind_unsupported' },
    });
    expect(stub.requests).toEqual([]);
  });

  it('propagates cancellation while a provider detail connection is pending', async () => {
    const caller = new AbortController();
    const stub = createStubGithubTransport({
      signal: caller.signal,
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? new Promise<StubHttpResponse>(() => {}) : undefined,
    });
    const pending = readGithubPullRequestStatus(statusInput(), stub.context);
    caller.abort(new DOMException('The host invocation reached its deadline.', 'TimeoutError'));
    await expect(pending).resolves.toEqual({
      kind: 'unavailable', failure: { class: 'transient', code: 'github_request_timed_out' },
    });
  });
});
