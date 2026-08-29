import {
  TriageDetailSurfaceInputV1Schema,
  TriageGetResultV1Schema,
  TriageListInstancesResultV1Schema,
  TriageScanInputV1Schema,
  TriageScanResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import currentUser from '../fixtures/currentUser.json' with { type: 'json' };
import errorNotFound from '../fixtures/errorNotFound.json' with { type: 'json' };
import pageOne from '../fixtures/pullRequestsPageOne.json' with { type: 'json' };
import pageTwo from '../fixtures/pullRequestsPageTwo.json' with { type: 'json' };
import pullRequestSelf from '../fixtures/pullRequestSelf.json' with { type: 'json' };
import reviewPage from '../fixtures/pullRequestsReviewPage.json' with { type: 'json' };
import repositoriesPage from '../fixtures/workspaceRepositoriesPage.json' with { type: 'json' };
import workspacesPage from '../fixtures/userWorkspacesPage.json' with { type: 'json' };
import { encodeBitbucketConfiguration } from '../instance.js';
import { decodeBitbucketScanContinuation } from '../scanContinuation.js';
import { scanBitbucketSourceAction } from './actions.js';
import { projectBitbucketDetailOverview } from './detail.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import { getBitbucketSourceEntry } from './get.js';
import { listBitbucketSourceInstances } from './listInstances.js';
import { scanBitbucketSource } from './scan.js';
import {
  accountRef,
  createConnectedAccountsStub,
  createHttpStub,
  createInvocationContext,
  createRuntime,
  type StubReply,
} from './testSupport.js';

afterEach(() => {
  vi.useRealTimers();
});

const WORKSPACE_UUID = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
const REPOSITORY_UUID = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';
/** The credential's own provider-native identity, as `fixtures/currentUser.json` reports it. */
const VIEWER_UUID = '{9f1c2a44-5d0e-4c8b-8b0a-1d7e6f3a2c19}';
const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: 'happier.scm.forge.bitbucket',
  localId: 'bitbucket-forge',
});

function configurationToken(workspaceUuid: string): string {
  const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid });
  if (!encoded.ok) throw new Error('fixture configuration must encode');
  return encoded.token;
}

function configuredInstance(
  overrides: Partial<{ localInstanceKey: string; workspaceUuid: string }> = {},
): TriageConfiguredSourceInstanceV1 {
  const workspaceUuid = overrides.workspaceUuid ?? WORKSPACE_UUID;
  return {
    v: 1,
    instance: {
      source: SOURCE_CONTRIBUTION,
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: {
      purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      account: accountRef('account-1'),
    },
    localInstanceKey: overrides.localInstanceKey ?? workspaceUuid,
    configuration: { v: 1, token: configurationToken(workspaceUuid) },
    locator: { v: 1, displayLabel: 'Example Workspace' },
  } as TriageConfiguredSourceInstanceV1;
}

function routeBitbucket(overrides: Readonly<Record<string, StubReply>> = {}) {
  return (url: string): StubReply | undefined => {
    for (const [fragment, reply] of Object.entries(overrides)) {
      if (url.includes(fragment)) return reply;
    }
    if (url.includes('/2.0/user/workspaces')) return { body: workspacesPage };
    if (url.includes('/2.0/user')) return { body: currentUser };
    if (url.includes('/pullrequests/42')) return { body: pullRequestSelf };
    if (url.includes('/2.0/repositories/') && url.includes('/pullrequests')) {
      return { body: { pagelen: 10, page: 1, values: [] } };
    }
    if (url.includes('/2.0/repositories/')) return { body: repositoriesPage };
    if (url.includes('/pullrequests/')) return { body: pageOne };
    return undefined;
  };
}

describe('Bitbucket listInstances', () => {
  it('emits one candidate per exact account and workspace UUID', async () => {
    const { connectedAccounts, materializations } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }, { accountId: 'account-2' }],
    });
    const { http } = createHttpStub(routeBitbucket());

    const result = TriageListInstancesResultV1Schema.parse(
      await listBitbucketSourceInstances(createRuntime(connectedAccounts, http)),
    );

    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    expect(materializations).toEqual(['account-1', 'account-2']);
    expect(result.candidates.map((candidate) => [
      candidate.binding.account.accountId,
      candidate.localInstanceKey,
    ])).toEqual([
      ['account-1', WORKSPACE_UUID],
      ['account-1', '{6d4a1f8b-2c93-4e05-b71a-8f2c5d09e364}'],
      ['account-2', WORKSPACE_UUID],
      ['account-2', '{6d4a1f8b-2c93-4e05-b71a-8f2c5d09e364}'],
    ]);
    // Two accounts reaching one workspace stay two candidates on the same source-native key: the
    // exact binding is a separate tuple member, so the key never re-encodes account identity.
    expect(result.candidates[0]?.localInstanceKey).toBe(result.candidates[2]?.localInstanceKey);
    expect(result.candidates[0]?.keyStability).toBe('stable');
    expect(JSON.stringify(result.candidates)).not.toContain('Basic ');
  });

  it('carries every discovered workspace candidate instead of imposing a local thirty-two-instance ceiling', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: Array.from({ length: 17 }, (_unused, index) => ({ accountId: `account-${index + 1}` })),
    });
    const { http } = createHttpStub(routeBitbucket());

    const result = TriageListInstancesResultV1Schema.parse(
      await listBitbucketSourceInstances(createRuntime(connectedAccounts, http)),
    );

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected a complete result');
    expect(result.candidates).toHaveLength(34);
  });

  it('never reports a truncated account listing as a complete enumeration', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
      status: 'truncated',
    });
    const { http } = createHttpStub(routeBitbucket());

    const result = await listBitbucketSourceInstances(createRuntime(connectedAccounts, http));

    expect(result.kind).toBe('incomplete');
    if (result.kind !== 'incomplete') return;
    expect(result.candidates).toHaveLength(2);
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: 'account-listing-truncated',
    });
  });

  it('attributes one account failure to its exact binding without failing the enumeration', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [
        { accountId: 'account-1', state: 'reconnectRequired' },
        { accountId: 'account-2' },
      ],
    });
    const { http } = createHttpStub(routeBitbucket());

    const result = await listBitbucketSourceInstances(createRuntime(connectedAccounts, http));

    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    expect(result.failures).toEqual([{
      binding: {
        purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
        account: accountRef('account-1'),
      },
      failure: {
        class: 'authentication',
        code: 'account-not-connected',
        detail: 'reconnectRequired',
      },
    }]);
    expect(result.candidates.every((candidate) => (
      candidate.binding.account.accountId === 'account-2'
    ))).toBe(true);
  });

  it('keeps a failed workspace walk attributed and refuses to call its candidate set complete', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(routeBitbucket({
      '/2.0/user/workspaces': { status: 503, body: errorNotFound },
    }));

    const result = TriageListInstancesResultV1Schema.parse(
      await listBitbucketSourceInstances(createRuntime(connectedAccounts, http)),
    );

    expect(result.kind).toBe('incomplete');
    if (result.kind !== 'incomplete') return;
    expect(result.candidates).toEqual([]);
    expect(result.failures[0]?.failure).toMatchObject({ class: 'transient' });
    expect(result.failure).toMatchObject({ class: 'transient' });
  });
});

describe('Bitbucket scan', () => {
  it('uses the caller signal across successive provider requests without inventing a timeout', async () => {
    vi.useFakeTimers();
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    let requests = 0;
    const http = {
      async request(input: Parameters<HttpService['request']>[0], options?: Readonly<{ signal?: AbortSignal }>) {
        requests += 1;
        expect(input.timeoutMs).toBeUndefined();
        return await new Promise<Awaited<ReturnType<HttpService['request']>>>((resolve, reject) => {
          const timer = setTimeout(() => {
            const body = input.url.includes('/2.0/user')
              ? currentUser
              : { pagelen: 50, page: 1, values: [] };
            resolve({
              status: 200,
              finalUrl: input.url,
              headers: {},
              body: new TextEncoder().encode(JSON.stringify(body)),
            });
          }, 15_000);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(options.signal?.reason);
          }, { once: true });
        });
      },
      openWebSocket() {
        throw new Error('not used');
      },
    } as unknown as HttpService;

    const caller = new AbortController();
    const pending = scanBitbucketSourceAction(
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 32 },
      }),
      createInvocationContext(connectedAccounts, http, caller.signal),
    );

    await vi.advanceTimersByTimeAsync(16_000);
    expect(requests).toBe(2);
    caller.abort(new DOMException('The caller stopped the scan.', 'AbortError'));
    const result = await pending;
    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'transient', code: 'invocation-cancelled' },
    });
  });

  it('projects the authored lane and reports unavailable native lanes as partial', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http, requests } = createHttpStub(routeBitbucket());

    const result = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 32 },
      }),
    ));

    // The budget held one native page, and the repository lanes are still open, so the walk
    // settles as a page and hands its own frontier back rather than claiming to have finished.
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations.map((observation) => (
      observation.kind === 'present' ? observation.localRef.entryId : observation.kind
    ))).toEqual(['42', '41']);
    // Three of the five canonical lanes cannot be served here, so the walk still lowers to a
    // bounded partial outcome rather than presenting empty lanes as successful.
    expect(result.evidence).toMatchObject({ kind: 'partial', reason: 'lane-unavailable' });
    // The continuation carries a frontier and nothing else: no credential, no account ref, no
    // origin, no accumulated rows.
    expect(result.continuation.token).not.toContain('Basic ');
    expect(result.continuation.token).not.toContain('account-1');
    expect(result.continuation.token).not.toContain('bitbucket-connected-account');
    expect(result.continuation.token).not.toContain('\"42\"');
    // Every request is origin-checked and carries the invocation's own page geometry.
    expect(requests.every(({ url }) => url.startsWith('https://api.bitbucket.org/2.0/'))).toBe(true);
    expect(requests.some(({ url }) => url.includes('/pullrequests/%7B9f1c2a44'))).toBe(true);
  });

  it('settles a repeated pull-request next without minting an identical Load More continuation', async () => {
    const route = (url: string): StubReply | undefined => {
      if (url.includes('/2.0/user')) return { body: currentUser };
      if (url.includes('/workspaces/') && url.includes('/pullrequests/')) {
        return { body: { ...pageOne, next: url } };
      }
      return { body: { pagelen: 100, page: 1, values: [] } };
    };
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http, requests } = createHttpStub(route);

    const result = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 32 },
      }),
    ));

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations.map((observation) => (
      observation.kind === 'present' ? observation.localRef.entryId : observation.kind
    ))).toEqual(['42', '41']);
    expect(result.evidence).toMatchObject({ kind: 'partial', reason: 'lane-unresolved' });
    expect(decodeBitbucketScanContinuation(result.continuation)?.authored)
      .toMatchObject({ nextUrl: null, ended: true });

    const settled = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: result.continuation },
      }),
    ));
    expect(settled.kind).toBe('complete');
    expect(settled.kind !== 'failed' && settled.evidence)
      .toMatchObject({ kind: 'partial', reason: 'lane-unresolved' });
    expect(requests.filter(({ url }) => url.includes('/workspaces/') && url.includes('/pullrequests/')))
      .toHaveLength(1);
  });

  it('settles an authored A-B-A cursor cycle across Load More calls', async () => {
    let authoredRequests = 0;
    let firstUrl = '';
    const route = (url: string): StubReply | undefined => {
      if (url.includes('/2.0/user')) return { body: currentUser };
      if (url.includes('/workspaces/') && url.includes('/pullrequests/')) {
        authoredRequests += 1;
        if (authoredRequests === 1) {
          firstUrl = url;
          return { body: { ...pageOne, next: `${url}&page=2` } };
        }
        return { body: { ...pageOne, next: firstUrl } };
      }
      return { body: { pagelen: 100, page: 1, values: [] } };
    };
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(route);
    const runtime = createRuntime(connectedAccounts, http);
    const initial = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      runtime,
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 32 },
      }),
    ));
    expect(initial.kind).toBe('page');
    if (initial.kind !== 'page') return;

    const cycled = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      runtime,
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: initial.continuation },
      }),
    ));
    expect(cycled.kind).toBe('complete');
    expect(cycled.kind !== 'failed' && cycled.observations).toHaveLength(2);
    expect(cycled.kind !== 'failed' && cycled.evidence)
      .toMatchObject({ kind: 'partial', reason: 'lane-unresolved' });
    expect(authoredRequests).toBe(2);
  });

  it('walks authored and per-repository review lanes to exhaustion across continuation pages', async () => {
    const REPOSITORY_B_UUID = '{2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901}';
    const repositoriesUrl = `https://api.bitbucket.org/2.0/repositories/%7B4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44%7D`;
    // One repository per page, so the lane set genuinely grows while the walk runs — the shape a
    // fixed N-way budget split cannot serve, because N is unknown when the budget is bound.
    const repositoryPage = (uuid: string, next: string | null) => ({
      pagelen: 10,
      page: next === null ? 2 : 1,
      values: [{ type: 'repository', uuid, name: 'repo', full_name: `example-workspace/${uuid}` }],
      ...(next === null ? {} : { next }),
    });
    // The walk is unfiltered, so a row reaches a review lane only by carrying the viewer's own
    // reviewer or participant evidence; the projection is what puts that evidence on a list page.
    const reviewRow = (id: number, repositoryUuid: string) => ({
      id,
      title: `Review me ${id}`,
      state: 'OPEN',
      destination: { repository: { uuid: repositoryUuid, full_name: 'example-workspace/repo' } },
      reviewers: [{ type: 'user', uuid: VIEWER_UUID }],
      participants: [],
    });

    let repositoryRequests = 0;
    const route = (url: string): StubReply | undefined => {
      if (url.includes('/2.0/user')) return { body: currentUser };
      if (url.includes('/2.0/repositories/') && !url.includes('/pullrequests')) {
        repositoryRequests += 1;
        return url.includes('page=2')
          ? { body: repositoryPage(REPOSITORY_B_UUID, null) }
          : { body: repositoryPage(REPOSITORY_UUID, `${repositoriesUrl}?page=2&pagelen=100`) };
      }
      if (url.includes('/workspaces/')) {
        return url.includes('page=2') ? { body: pageTwo } : { body: pageOne };
      }
      if (url.includes(encodeURIComponent(REPOSITORY_UUID))) {
        return { body: { pagelen: 10, page: 1, values: [reviewRow(101, REPOSITORY_UUID)] } };
      }
      if (url.includes(encodeURIComponent(REPOSITORY_B_UUID))) {
        return { body: { pagelen: 10, page: 1, values: [reviewRow(102, REPOSITORY_B_UUID)] } };
      }
      return undefined;
    };

    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http, requests } = createHttpStub(route);
    const runtime = createRuntime(connectedAccounts, http);

    const seen: string[] = [];
    let page = TriageScanInputV1Schema.parse({
      v: 1,
      instance: configuredInstance(),
      page: { kind: 'initial', limit: 10 },
    });
    let arms = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = TriageScanResultV1Schema.parse(await scanBitbucketSource(runtime, page));
      if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
      arms += 1;
      for (const observation of result.observations) {
        if (observation.kind === 'present') seen.push(observation.localRef.entryId);
      }
      // Every page respects the submitted limit, counting the rows it admits to having omitted.
      const omitted = result.evidence.kind === 'partial'
        ? result.evidence.omittedItemCount ?? 0
        : 0;
      expect(result.observations.length + omitted).toBeLessThanOrEqual(10);
      if (result.kind === 'complete') break;
      page = TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: result.continuation },
      });
    }

    // Every seeded lane contributed before the walk ended: the authored lane across both of its
    // pages, and each repository review lane including the one discovered mid-walk.
    expect([...seen].sort()).toEqual(['101', '102', '17', '41', '42']);
    expect(arms).toBeGreaterThan(1);
    // The repository listing is continued, never re-enumerated: two pages, two requests, no matter
    // how many scan pages the walk took.
    expect(repositoryRequests).toBe(2);
    expect(requests.every(({ url }) => url.startsWith('https://api.bitbucket.org/2.0/'))).toBe(true);

    // An interruption is not a resume point: a later attempt starts again at the initial page.
    const restarted = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      runtime,
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 10 },
      }),
    ));
    expect(restarted.kind !== 'failed' && restarted.observations.map((observation) => (
      observation.kind === 'present' ? observation.localRef.entryId : observation.kind
    ))).toEqual(['42', '41']);
  });

  it('serves the reviewed lane from participant approval a reviewers filter would have missed', async () => {
    const route = (url: string): StubReply | undefined => {
      if (url.includes('/2.0/user')) return { body: currentUser };
      if (url.includes('/2.0/repositories/') && !url.includes('/pullrequests')) {
        return {
          body: {
            pagelen: 100,
            page: 1,
            values: [{
              type: 'repository',
              uuid: REPOSITORY_UUID,
              name: 'deploy-tools',
              full_name: 'example-workspace/deploy-tools',
            }],
          },
        };
      }
      if (url.includes('/workspaces/')) return { body: { pagelen: 10, page: 1, values: [] } };
      return { body: reviewPage };
    };

    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http, requests } = createHttpStub(route);

    const result = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 50 },
      }),
    ));

    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    const present = result.observations.flatMap((observation) => (
      observation.kind === 'present' ? [observation] : []
    ));
    // 5421 is the case the cheap shape cannot reach: the viewer approved it without ever being a
    // requested reviewer, so its `reviewers` list is empty and no participant holds the REVIEWER
    // role. Appending the projection to the old `reviewers.uuid`-filtered walk would have returned
    // a correct subset that silently excluded exactly this pull request. 5423 is someone else's
    // pull request with someone else's approval: the unfiltered walk returns it, and nothing about
    // it involves this credential, so it is not published as this account's triage row.
    expect(present.map((observation) => observation.localRef.entryId)).toEqual(['5421', '5422']);
    expect(present[0]?.viewer.involvement).toEqual(['participating']);
    expect(present[1]?.viewer.involvement).toEqual(['reviewRequested']);
    // The native verdict survives as its own word rather than collapsing into the canonical token.
    expect(present[0]?.snapshot.facts).toContainEqual({
      id: 'bitbucket/your-review',
      importance: 'primary',
      value: { kind: 'status', value: 'Approved', tone: 'success' },
    });
    // Server-side narrowing is unavailable — Bitbucket refuses every `participants.*` predicate —
    // so the identity/approval correlation happens here, on evidence the row itself carries.
    const laneRequests = requests.filter(({ url }) => (
      url.includes('/2.0/repositories/') && url.includes('/pullrequests')
    ));
    expect(laneRequests).toHaveLength(1);
    expect(laneRequests[0]?.url).not.toContain('reviewers.uuid');
    expect(laneRequests[0]?.url).toContain('values.participants');
  });

  it('reports malformed nested review evidence without inventing a reviewed verdict or dropping independent involvement', async () => {
    const malformedReviewPage = {
      ...reviewPage,
      values: reviewPage.values.map((row, index) => ({
        ...row,
        participants: index === 0
          ? row.participants.map((participant) => (
            participant.user.uuid === VIEWER_UUID
              ? { ...participant, approved: 'true' }
              : participant
          ))
          : index === 1
            ? [{
              type: 'participant',
              role: 'PARTICIPANT',
              approved: 'true',
              state: 'approved',
              participated_on: null,
              user: { type: 'user', uuid: VIEWER_UUID },
            }]
            : row.participants,
      })),
    };
    const route = (url: string): StubReply | undefined => {
      if (url.includes('/2.0/user')) return { body: currentUser };
      if (url.includes('/2.0/repositories/') && !url.includes('/pullrequests')) {
        return {
          body: {
            pagelen: 100,
            page: 1,
            values: [{
              type: 'repository',
              uuid: REPOSITORY_UUID,
              name: 'deploy-tools',
              full_name: 'example-workspace/deploy-tools',
            }],
          },
        };
      }
      if (url.includes('/workspaces/')) return { body: { pagelen: 10, page: 1, values: [] } };
      return { body: malformedReviewPage };
    };

    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(route);
    const result = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 50 },
      }),
    ));

    if (result.kind === 'failed') throw new Error(`unexpected failure: ${result.failure.code}`);
    const present = result.observations.flatMap((observation) => (
      observation.kind === 'present' ? [observation] : []
    ));
    expect(present.map((observation) => observation.localRef.entryId)).toEqual(['5422']);
    expect(present[0]?.viewer.involvement).toEqual(['reviewRequested']);
    expect(present[0]?.snapshot.facts).not.toContainEqual(expect.objectContaining({
      id: 'bitbucket/your-review',
    }));
    expect(result.evidence).toEqual({
      kind: 'partial',
      reason: 'undecodable-items',
      omittedItemCount: 1,
    });
  });

  it('refuses a limit below the provider page minimum before any provider request', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http, requests } = createHttpStub(routeBitbucket());

    const result = await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 5 },
      }),
    );

    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'scan-limit-below-provider-page-minimum',
      },
    });
    // Two reads precede the walk — the viewer and the workspace repositories — but no lane page.
    expect(requests.some(({ url }) => url.includes('state=OPEN'))).toBe(false);
  });

  it('refuses a continuation it never issued', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http, requests } = createHttpStub(routeBitbucket());

    const result = await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: { v: 1, token: 'not-ours' } },
      }),
    );

    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'continuation-not-issued' },
    });
    expect(requests).toEqual([]);
  });

  it('encodes one current repository rather than the workspace inventory in its continuation', async () => {
    const repositoriesUrl = 'https://api.bitbucket.org/2.0/repositories/%7B4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44%7D';
    const repositoryUuid = (index: number) => (
      `{1a2b3c4d-5e6f-4071-8293-${String(index).padStart(12, '0')}}`
    );
    const workspaceOf = (count: number) => (url: string): StubReply | undefined => {
      if (url.includes('/2.0/user')) return { body: currentUser };
      if (url.includes('/2.0/repositories/') && !url.includes('/pullrequests')) {
        return {
          body: {
            pagelen: 100,
            page: 1,
            values: Array.from({ length: count }, (_unused, index) => ({
              type: 'repository',
              uuid: repositoryUuid(index),
              name: `repo-${index}`,
              full_name: `example-workspace/repo-${index}`,
            })),
            next: `${repositoriesUrl}?page=${Number(new URL(url).searchParams.get('page') ?? '1') + 1}&pagelen=100`,
          },
        };
      }
      // The workspace-wide authored lane ends immediately and costs nothing, so the walk reaches
      // the repository frontier inside the first call.
      if (url.includes('/workspaces/')) return { body: { pagelen: 10, page: 1, values: [] } };
      // Every repository review lane stays open, which is what a frontier holding one entry per
      // repository would have to encode.
      return {
        body: {
          pagelen: 10,
          page: 1,
          values: [{
            id: 900,
            title: 'Review me',
            state: 'OPEN',
            destination: { repository: { uuid: REPOSITORY_UUID, full_name: 'example-workspace/repo' } },
            reviewers: [{ type: 'user', uuid: VIEWER_UUID }],
            participants: [],
          }],
          next: `${repositoriesUrl}/repo/pullrequests?page=2&pagelen=64`,
        },
      };
    };

    const frontierFor = async (repositoryCount: number) => {
      const { connectedAccounts } = createConnectedAccountsStub({
        accounts: [{ accountId: 'account-1' }],
      });
      const { http } = createHttpStub(workspaceOf(repositoryCount));
      const result = TriageScanResultV1Schema.parse(await scanBitbucketSource(
        createRuntime(connectedAccounts, http),
        TriageScanInputV1Schema.parse({
          v: 1,
          instance: configuredInstance(),
          page: { kind: 'initial', limit: 64 },
        }),
      ));
      if (result.kind !== 'page') throw new Error(`expected a page arm, received ${result.kind}`);
      const frontier = decodeBitbucketScanContinuation(result.continuation);
      if (frontier === null) throw new Error('expected this source to decode its own continuation');
      return frontier;
    };

    // A repository the enumeration has not entered is pending, not open: it is not part of the
    // rotation and costs the token nothing. A frontier holding one entry per workspace repository
    // would exceed the paging bound on exactly the accounts the fairness rule exists to serve, and
    // would degrade that walk to a `complete` arm it never earned.
    const small = await frontierFor(2);
    const large = await frontierFor(2_000);
    expect(small.currentRepository?.lanes).toHaveLength(1);
    expect(large.currentRepository?.lanes).toHaveLength(1);
    expect(Object.keys(small).sort()).toEqual(Object.keys(large).sort());
  });

  it('carries walk health observed on an early Bitbucket page to the page that settles the walk', async () => {
    const authoredRow = (id: number) => ({
      id,
      title: `Authored ${id}`,
      state: 'OPEN',
      destination: { repository: { uuid: REPOSITORY_UUID, full_name: 'example-workspace/repo' } },
    });
    const route = (url: string): StubReply | undefined => {
      if (url.includes('/2.0/user')) return { body: currentUser };
      if (url.includes('/workspaces/') && url.includes('/pullrequests/')) {
        return url.includes('page=2')
          ? { body: { pagelen: 64, page: 2, values: [] } }
          : {
            body: {
              pagelen: 64,
              page: 1,
              // One row cannot be given a valid identity, so it is dropped tolerantly and charged
              // to the budget: the page still cost its raw provider cardinality.
              values: [
                { id: 'not-a-number', title: 'Broken', state: 'OPEN' },
                ...Array.from({ length: 63 }, (_unused, index) => authoredRow(index + 1)),
              ],
              next: `${url.split('?')[0] ?? url}?state=OPEN&pagelen=64&page=2`,
            },
          };
      }
      // An empty workspace ends the repository enumeration without a second listing page.
      return { body: { pagelen: 100, page: 1, values: [] } };
    };

    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(route);
    const runtime = createRuntime(connectedAccounts, http);

    const first = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      runtime,
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 64 },
      }),
    ));
    expect(first.kind).toBe('page');
    if (first.kind !== 'page') return;
    expect(first.evidence).toEqual({
      kind: 'partial',
      reason: 'undecodable-items',
      omittedItemCount: 1,
    });
    // The reason travels in the frontier as a name, never as a count: `omittedItemCount` stays a
    // per-call number so the target's `observations + omittedItemCount <= limit` check is exact.
    expect(decodeBitbucketScanContinuation(first.continuation)?.walkHealth)
      .toContain('undecodable-items');

    const settled = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      runtime,
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: first.continuation },
      }),
    ));

    expect(settled.kind).toBe('complete');
    // A walk that skipped a row on page one has not finished cleanly on page three. A frontier
    // carrying no walk-level health would report `walkFinished` for a walk it never witnessed
    // whole — the same silent-completeness failure the sticky set exists to prevent.
    expect(settled.kind !== 'failed' && settled.evidence)
      .toEqual({ kind: 'partial', reason: 'undecodable-items' });
  });

  it('never reports a finished walk after an incomplete Bitbucket repository enumeration', async () => {
    const repositoriesUrl = 'https://api.bitbucket.org/2.0/repositories/%7B4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44%7D';
    let repositoryPages = 0;
    const route = (url: string): StubReply | undefined => {
      if (url.includes('/2.0/user')) return { body: currentUser };
      if (url.includes('/2.0/repositories/') && !url.includes('/pullrequests')) {
        repositoryPages += 1;
        // The first listing page promises more, and the continuation of that listing fails. The
        // walk can end its lanes, but it can never call the workspace whole.
        return repositoryPages === 1
          ? {
            body: {
              pagelen: 100,
              page: 1,
              values: [{ type: 'repository', uuid: REPOSITORY_UUID, name: 'repo', full_name: 'example-workspace/repo' }],
              next: `${repositoriesUrl}?page=2&pagelen=100`,
            },
          }
          : { status: 500, body: { error: { message: 'listing unavailable' } } };
      }
      return { body: { pagelen: 64, page: 1, values: [] } };
    };

    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(route);

    const result = TriageScanResultV1Schema.parse(await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'initial', limit: 64 },
      }),
    ));

    expect(result.kind).toBe('complete');
    // The unenumerated repositories could hold review requests this result does not contain, so a
    // finished walk is exactly the claim this arm may not make.
    expect(result.kind !== 'failed' && result.evidence.kind).toBe('partial');
    expect(repositoryPages).toBe(2);
  });

  it('refuses a configured instance whose key and routing disagree', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http, requests } = createHttpStub(routeBitbucket());

    const result = await scanBitbucketSource(
      createRuntime(connectedAccounts, http),
      TriageScanInputV1Schema.parse({
        v: 1,
        instance: configuredInstance({
          localInstanceKey: '{6d4a1f8b-2c93-4e05-b71a-8f2c5d09e364}',
        }),
        page: { kind: 'initial', limit: 32 },
      }),
    );

    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'configuration-instance-mismatch' },
    });
    expect(requests).toEqual([]);
  });
});

describe('Bitbucket get', () => {
  it('reads one pull request authoritatively through its exact configured instance', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(routeBitbucket());

    const result = TriageGetResultV1Schema.parse(await getBitbucketSourceEntry(
      createRuntime(connectedAccounts, http),
      {
        v: 1,
        instance: configuredInstance(),
        localRef: {
          kindId: 'pull-request',
          collisionScope: `bitbucket:${REPOSITORY_UUID}`,
          entryId: '42',
        },
      },
    ));

    expect(result.kind).toBe('present');
    if (result.kind !== 'present') return;
    expect(result.localRef).toEqual({
      kindId: 'pull-request',
      collisionScope: `bitbucket:${REPOSITORY_UUID}`,
      entryId: '42',
    });
    // The authoritative `self` shape carries the description and complete reviewer roster needed
    // by the detail launch. Both survive as bounded projection rather than forcing the mounted
    // Overview to pretend the list-page omission was an authoritative empty answer.
    expect(result.snapshot.facts.find((fact) => fact.id === 'bitbucket/reviewers'))
      .toMatchObject({ value: { kind: 'text', value: 'Example Maintainer, Example Reviewer' } });
    expect(result.snapshot.summary).toBe(pullRequestSelf.summary.raw);
    // The routing token is the repository locator, so the entry stays addressable without the
    // caller re-deriving a path from identity.
    expect(result.locator.routingToken).toBe('example-workspace/deploy-tools');
  });

  it('never concludes absence from a 404 under one credential', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(routeBitbucket({
      '/pullrequests/42': { status: 404, body: errorNotFound },
    }));

    const result = await getBitbucketSourceEntry(
      createRuntime(connectedAccounts, http),
      {
        v: 1,
        instance: configuredInstance(),
        localRef: {
          kindId: 'pull-request',
          collisionScope: `bitbucket:${REPOSITORY_UUID}`,
          entryId: '42',
        },
      },
    );

    expect(result.kind).toBe('unresolved');
    if (result.kind !== 'unresolved') return;
    expect(result.failure).toMatchObject({ class: 'unknown', code: 'route-not-found' });
  });

  it('refuses an entry id outside the provider grammar, exactly as the detail path does', async () => {
    // `get` and the detail/mutation path admit the SAME invocation, so they must
    // answer the same question the same way. `invocationAdmission.ts` gates on
    // `isBitbucketEntryId`; `get` carried its own inline copy of the admission
    // sequence that had never grown that gate, so a ref the detail path refused
    // was accepted here and reached the provider as a malformed route.
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(routeBitbucket());

    const result = await getBitbucketSourceEntry(
      createRuntime(connectedAccounts, http),
      {
        v: 1,
        instance: configuredInstance(),
        localRef: {
          kindId: 'pull-request',
          collisionScope: `bitbucket:${REPOSITORY_UUID}`,
          entryId: '0042',
        },
      },
    );

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'entry-id-invalid' },
    });
  });

  it('refuses a collision scope this source did not mint', async () => {
    const { connectedAccounts, materializations } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(routeBitbucket());

    const result = await getBitbucketSourceEntry(
      createRuntime(connectedAccounts, http),
      {
        v: 1,
        instance: configuredInstance(),
        localRef: {
          kindId: 'pull-request',
          collisionScope: 'github:owner/name',
          entryId: '42',
        },
      },
    );

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'collision-scope-invalid' },
    });
    expect(materializations).toEqual([]);
  });
});

describe('Bitbucket detail projection', () => {
  it('renders the applied observation and preserves an unavailable linked Session', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1' }],
    });
    const { http } = createHttpStub(routeBitbucket());
    const observation = await getBitbucketSourceEntry(
      createRuntime(connectedAccounts, http),
      {
        v: 1,
        instance: configuredInstance(),
        localRef: {
          kindId: 'pull-request',
          collisionScope: `bitbucket:${REPOSITORY_UUID}`,
          entryId: '42',
        },
      },
    );
    expect(observation.kind).toBe('present');
    if (observation.kind !== 'present') return;

    const detailInput = TriageDetailSurfaceInputV1Schema.parse({
      v: 1,
      instance: configuredInstance(),
      observation: {
        entryRef: { source: SOURCE_CONTRIBUTION, ...observation.localRef },
        observedAtMs: 1_760_000_700_000,
        locator: observation.locator,
        snapshot: observation.snapshot,
        viewer: observation.viewer,
        ...(observation.sourceUpdatedAtMs === undefined
          ? {}
          : { sourceUpdatedAtMs: observation.sourceUpdatedAtMs }),
      },
      linkedSessions: [{ sessionId: 'session-1' }],
    });

    const overview = projectBitbucketDetailOverview(detailInput);

    expect(overview).toMatchObject({
      title: 'Bound the deployment poller to its invocation deadline',
      scopeLabel: 'example-workspace/deploy-tools',
      state: { presentation: 'active', nativeLabel: 'Open' },
      webUrl: 'https://bitbucket.org/example-workspace/deploy-tools/pull-requests/42',
      // The five-fact bound dropped this row's supplementary facts, and the reader is told so
      // rather than shown a list that quietly claims to be complete.
      projectionTruncated: true,
    });
    // The entry's Session relationship belongs to the Triage common header, so this source-owned
    // projection publishes none of it. `linkedSessions` on the launch input above is what makes
    // this discriminating: a projection that still carried it would have something to copy.
    expect(overview).not.toHaveProperty('linkedSessions');
    expect(overview.summary).toBe(pullRequestSelf.summary.raw);
    expect(overview.fields.find((field) => field.id === 'bitbucket/reviewers'))
      .toMatchObject({ kind: 'text', value: 'Example Maintainer, Example Reviewer' });
  });
});

/**
 * A reader with no connected Bitbucket account has configured nothing. The host
 * declines to list an unbound purpose, and reporting that decline as a Bitbucket
 * failure accuses a provider this source never contacted.
 */
describe('Bitbucket listInstances with no connected account', () => {
  const NOT_SELECTED = Object.assign(new Error('resource not selected'), {
    code: 'plugin_host_access_resource_not_selected',
  });

  it('reports an unbound purpose as a complete empty candidate set', async () => {
    const { connectedAccounts, bindingReads } = createConnectedAccountsStub({
      accounts: [],
      listError: NOT_SELECTED,
      binding: null,
    });
    const http = createHttpStub({});

    const result = await listBitbucketSourceInstances(createRuntime(connectedAccounts, http));

    expect(TriageListInstancesResultV1Schema.parse(result)).toEqual(result);
    expect(result).toEqual({ kind: 'complete', candidates: [], failures: [] });
    expect(bindingReads).toEqual([BITBUCKET_CONNECTED_ACCOUNT_PURPOSE]);
  });

  it('still fails a refused listing while the purpose is bound', async () => {
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [],
      listError: NOT_SELECTED,
    });
    const http = createHttpStub({});

    const result = await listBitbucketSourceInstances(createRuntime(connectedAccounts, http));

    expect(result.kind).toBe('failed');
  });
});
