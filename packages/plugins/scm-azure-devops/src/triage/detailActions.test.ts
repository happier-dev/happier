import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeAzureSourceConfiguration } from './configuration.js';
import { AZURE_DEVOPS_TRIAGE_PURPOSE } from './descriptor.js';
import {
  AzureCommitsResultV1Schema,
  AzureIterationChangesResultV1Schema,
  AzureIterationsResultV1Schema,
  AzurePoliciesResultV1Schema,
  AzureThreadsResultV1Schema,
} from './detail/contracts.js';
import { AZURE_BUILD_VALIDATION_POLICY_TYPE_ID_V1 } from './detail/projection.js';
import { buildAzureCollisionScope } from './identity.js';
import {
  AZURE_DEVOPS_MOUNTED_DETAIL_DEADLINE_MS,
  listAzureDevOpsCommits,
  listAzureDevOpsIterationChanges,
  readAzureDevOpsIterations,
  readAzureDevOpsPolicies,
  readAzureDevOpsThreads,
} from './detailActions.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';

const BASE_URL = 'https://dev.azure.com/acme';
const PROJECT_ID = '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const REPOSITORY_ID = 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b';
const PULL_REQUEST_ID = 17;

function accountRef(accountId: string): QualifiedConnectedAccountRef {
  return {
    service: { pluginId: 'happier.scm.forge.azure-devops', localId: AZURE_DEVOPS_TRIAGE_PURPOSE },
    accountId,
  };
}

function configuredOrigin() {
  const result = normalizeAzureDevOpsBaseUrl(BASE_URL);
  if (!result.ok) throw new Error('fixture base is not normalizable');
  return result.origin;
}

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
  return {
    v: 1,
    instance: {
      source: { pluginId: 'happier.scm.forge.azure-devops', localId: 'azure-devops-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account: accountRef('account-1') },
    localInstanceKey: BASE_URL,
    configuration: encodeAzureSourceConfiguration(configuredOrigin()),
  };
}

/** The collision scope this source itself mints for the fixture repository. */
function collisionScope(): string {
  const scope = buildAzureCollisionScope({
    origin: configuredOrigin(),
    repositoryId: REPOSITORY_ID,
  });
  if (scope === null) throw new Error('the fixture repository must have a scope');
  return scope;
}

function localRef() {
  return {
    kindId: 'pull-request',
    collisionScope: collisionScope(),
    entryId: String(PULL_REQUEST_ID),
  };
}

function planeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: localRef(),
    routingToken: `${REPOSITORY_ID}/${String(PULL_REQUEST_ID)}`,
    ...overrides,
  };
}

type Route = Readonly<{
  status?: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}>;

/**
 * The host HTTP service and the generic Connected Accounts service are the two
 * genuine system boundaries these tests cross. Everything below them — route
 * construction, api-version pinning, admission, projection and the published
 * result schema — runs for real.
 */
function harness(respond: (url: string) => Route | undefined) {
  const urls: string[] = [];
  const services = {
    connectedAccounts: {
      // Every authorized read re-confirms its exact configured base against the account's
      // own published bases, so the fixture account publishes the one these tests route by.
      async listAccounts() {
        return {
          status: 'complete' as const,
          accounts: [{
            account: accountRef('account-1'),
            displayName: 'Acme',
            state: 'connected' as const,
            connectedAccountOrigins: ['https://dev.azure.com'],
            connectedAccountBases: [BASE_URL],
          }],
        };
      },
      async getBinding(purpose: string) {
        return {
          purpose,
          service: accountRef('account-1').service,
          account: accountRef('account-1'),
          target: { kind: 'account' as const, displayName: 'Acme' },
        };
      },
      async materializeListedAccount() {
        return { kind: 'httpHeaders' as const, headers: { authorization: 'Basic <pat>' } };
      },
    },
    http: {
      async request(request: Readonly<{ url: string }>) {
        urls.push(request.url);
        const route = respond(request.url);
        if (route === undefined) throw new Error(`unexpected request: ${request.url}`);
        return {
          status: route.status ?? 200,
          finalUrl: request.url,
          headers: { 'content-type': 'application/json', ...route.headers },
          body: new TextEncoder().encode(
            typeof route.body === 'string' ? route.body : JSON.stringify(route.body),
          ),
        };
      },
    },
  };
  const context = {
    plugin: { id: 'happier.scm.forge.azure-devops', version: '0.0.0' },
    contribution: { id: 'azure-devops-forge', qualifiedId: 'x/contributions/azure-devops-forge' },
    surface: 'background',
    caller: { kind: 'plugin', pluginId: 'happier.triage' },
    signal: new AbortController().signal,
    services: services as unknown as PluginInvocationContext['services'],
  } as unknown as PluginInvocationContext;
  return { context, urls };
}

function collection(values: readonly unknown[]): Route {
  return { body: { count: values.length, value: values } };
}

/* ---------------------------------------------------------------- iterations */

describe('Azure iterations read', () => {
  it('names the highest real iteration and never publishes the comparison baseline', async () => {
    const seam = harness((url) => (
      url.includes('/iterations?') || url.endsWith('/iterations')
        ? collection([
          { id: 1, description: 'first push', createdDate: '2026-08-01T00:00:00Z' },
          { id: 2, description: 'second push', createdDate: '2026-08-02T00:00:00Z' },
          // Azure never returns this, and a projection that accepted it would
          // let a caller path-address a resource that does not exist.
          { id: 0, description: 'baseline' },
        ])
        : undefined
    ));

    const settled = AzureIterationsResultV1Schema.parse(
      await readAzureDevOpsIterations(planeInput(), seam.context),
    );
    if (settled.kind !== 'iterations') throw new Error('the iteration read must settle');
    expect(settled.rows.map((row) => row.id)).toEqual([1, 2]);
    expect(settled.currentIterationId).toBe(2);
    // The `0` row is counted as omitted, not silently discarded.
    expect(settled.omittedRowCount).toBe(1);
  });

  it('publishes no current iteration when Azure returned none', async () => {
    const seam = harness((url) => (
      url.includes('/iterations') ? collection([]) : undefined
    ));
    const settled = AzureIterationsResultV1Schema.parse(
      await readAzureDevOpsIterations(planeInput(), seam.context),
    );
    if (settled.kind !== 'iterations') throw new Error('the iteration read must settle');
    // Absent, not `0`: a pull request with no iterations has none to compare.
    expect(settled).not.toHaveProperty('currentIterationId');
  });

  it('pins its api-version rather than letting the server choose a contract', async () => {
    const seam = harness((url) => (url.includes('/iterations') ? collection([]) : undefined));
    await readAzureDevOpsIterations(planeInput(), seam.context);
    expect(seam.urls[0]).toContain('api-version=7.1');
  });
});

/* --------------------------------------------------------- iteration changes */

describe('Azure iteration changes plane', () => {
  const CHANGE = Object.freeze({
    changeType: 'edit',
    item: { path: '/src/a.ts', objectId: 'a'.repeat(40), isFolder: false },
  });

  it('follows Azure iteration changes only through response-issued nextSkip and nextTop', async () => {
    const seam = harness((url) => (
      url.includes('/iterations/2/changes')
        ? { body: { changeEntries: [CHANGE], nextSkip: 100, nextTop: 100 } }
        : undefined
    ));

    const settled = AzureIterationChangesResultV1Schema.parse(
      await listAzureDevOpsIterationChanges(planeInput({ iterationId: 2 }), seam.context),
    );
    if (settled.kind !== 'iterationChanges') throw new Error('the changes page must settle');
    // The next window is exactly what Azure issued. Nothing here adds to the
    // offset it was given.
    expect(settled.nextSkip).toBe(100);
    expect(settled.nextTop).toBe(100);
    expect(seam.urls[0]).toContain('$skip=0');
    expect(seam.urls[0]).toContain('$compareTo=0');
  });

  it('ends the walk when Azure issues two zeroes rather than inventing the next offset', async () => {
    const seam = harness((url) => (
      url.includes('/iterations/2/changes')
        ? { body: { changeEntries: [CHANGE], nextSkip: 0, nextTop: 0 } }
        : undefined
    ));
    const settled = AzureIterationChangesResultV1Schema.parse(
      await listAzureDevOpsIterationChanges(planeInput({ iterationId: 2 }), seam.context),
    );
    if (settled.kind !== 'iterationChanges') throw new Error('the changes page must settle');
    expect(settled).not.toHaveProperty('nextSkip');
    expect(settled).not.toHaveProperty('nextTop');
  });

  it('uses compareTo=0 while never path-addressing iteration 0', async () => {
    const seam = harness(() => undefined);
    // A `0` iteration id is refused by the published input shape, before a URL
    // could name it as a resource.
    const settled = AzureIterationChangesResultV1Schema.parse(
      await listAzureDevOpsIterationChanges(planeInput({ iterationId: 0 }), seam.context),
    );
    expect(settled.kind).toBe('unavailable');
    expect(seam.urls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ policies */

describe('Azure policies plane', () => {
  const PULL_REQUEST = Object.freeze({
    pullRequestId: PULL_REQUEST_ID,
    repository: {
      id: REPOSITORY_ID,
      name: 'checkout',
      project: { id: PROJECT_ID, name: 'Payments' },
    },
  });

  function respondWith(evaluations: Route): (url: string) => Route | undefined {
    return (url) => {
      if (url.includes('/policy/evaluations')) return evaluations;
      if (url.includes('/statuses')) {
        return collection([
          { id: 4, state: 'succeeded', description: 'Ran the gate', context: { genre: 'ci', name: 'gate' } },
        ]);
      }
      if (url.includes('/pullRequests/17') || url.includes('/pullrequests/17')) {
        return { body: PULL_REQUEST };
      }
      return undefined;
    };
  }

  it('takes enforcement only from a returned evaluation, never from a status', async () => {
    const seam = harness(respondWith(collection([
      {
        evaluationId: 'e1',
        status: 'approved',
        configuration: { isBlocking: true, type: { id: 'aaaaaaaa-0000-0000-0000-000000000000', displayName: 'Reviewers' } },
      },
    ])));

    const settled = AzurePoliciesResultV1Schema.parse(
      await readAzureDevOpsPolicies(planeInput(), seam.context),
    );
    if (settled.kind !== 'policies') throw new Error('the policies read must settle');
    // A succeeded status is informational; the blocking fact came from the
    // evaluation's own configuration.
    expect(settled.statuses).toHaveLength(1);
    expect(settled.evaluations[0]?.isBlocking).toBe(true);
    expect(settled.evaluations[0]?.isBuildValidation).toBe(false);
  });

  it('classifies a build validation only by its documented configuration type id', async () => {
    const seam = harness(respondWith(collection([
      {
        evaluationId: 'e1',
        status: 'running',
        // Named "Build" but a different policy type: display text must not
        // reclassify a customer policy as a build validation.
        configuration: { isBlocking: false, type: { id: 'bbbbbbbb-0000-0000-0000-000000000000', displayName: 'Build' } },
      },
      {
        evaluationId: 'e2',
        status: 'approved',
        configuration: {
          isBlocking: true,
          type: { id: AZURE_BUILD_VALIDATION_POLICY_TYPE_ID_V1, displayName: 'Something else' },
        },
      },
    ])));

    const settled = AzurePoliciesResultV1Schema.parse(
      await readAzureDevOpsPolicies(planeInput(), seam.context),
    );
    if (settled.kind !== 'policies') throw new Error('the policies read must settle');
    expect(settled.evaluations.map((row) => row.isBuildValidation)).toEqual([false, true]);
  });

  it('renders a missing evaluation time as unknown rather than a zero duration', async () => {
    const seam = harness(respondWith(collection([
      {
        evaluationId: 'e1',
        status: 'running',
        startedDate: '2026-08-01T00:00:00Z',
        // No completedDate: this evaluation has not finished.
        configuration: { isBlocking: true, type: { id: 'cccccccc-0000-0000-0000-000000000000' } },
      },
    ])));

    const settled = AzurePoliciesResultV1Schema.parse(
      await readAzureDevOpsPolicies(planeInput(), seam.context),
    );
    if (settled.kind !== 'policies') throw new Error('the policies read must settle');
    const evaluation = settled.evaluations[0];
    expect(evaluation?.startedAtMs).toBeTypeOf('number');
    expect(evaluation).not.toHaveProperty('completedAtMs');
  });

  it('keeps the statuses when only the evaluation read fails', async () => {
    const seam = harness(respondWith({ status: 403, body: { message: 'forbidden' } }));

    const settled = AzurePoliciesResultV1Schema.parse(
      await readAzureDevOpsPolicies(planeInput(), seam.context),
    );
    if (settled.kind !== 'policies') throw new Error('the policies read must settle');
    // The statuses are real and stay; only the evaluation half is short.
    expect(settled.statuses).toHaveLength(1);
    expect(settled.evaluations).toHaveLength(0);
    expect(settled.evaluationsPartial).toBe(true);
  });

  it('does not publish stale statuses as partial when cancellation wins during evaluation paging', async () => {
    const caller = new AbortController();
    const otherRoutes = respondWith(collection([]));
    const seam = harness((url) => {
      if (!url.includes('/policy/evaluations')) return otherRoutes(url);
      // The transport race is deliberate: an already-started request can still resolve after
      // navigation. A cancellation is not an ordinary later-page failure the Policies tab may
      // retain as partial evidence.
      caller.abort();
      return collection([]);
    });
    const context = { ...seam.context, signal: caller.signal } as PluginInvocationContext;

    const settled = AzurePoliciesResultV1Schema.parse(
      await readAzureDevOpsPolicies(planeInput(), context),
    );

    if (settled.kind !== 'unavailable') throw new Error('cancellation must prevent publication');
    expect(settled.failure.code).toBe('azure-devops/cancelled');
  });

  it('addresses policy evaluations through the project, not the Git repository', async () => {
    const seam = harness(respondWith(collection([])));
    await readAzureDevOpsPolicies(planeInput(), seam.context);
    const evaluationUrl = seam.urls.find((url) => url.includes('/policy/evaluations'));
    expect(evaluationUrl).toContain('/Payments/_apis/policy/evaluations');
    expect(evaluationUrl).toContain(
      encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${PROJECT_ID}/17`),
    );
  });

  it('reads every policy-evaluation page before reporting the plane complete', async () => {
    const evaluations = Array.from({ length: 101 }, (_, index) => ({
      evaluationId: `evaluation-${String(index + 1)}`,
      status: 'approved',
      configuration: { isBlocking: false, type: { id: `type-${String(index + 1)}` } },
    }));
    const otherRoutes = respondWith(collection([]));
    const seam = harness((url) => {
      if (!url.includes('/policy/evaluations')) return otherRoutes(url);
      return collection(url.includes('$skip=100') ? evaluations.slice(100) : evaluations.slice(0, 100));
    });

    const settled = AzurePoliciesResultV1Schema.parse(
      await readAzureDevOpsPolicies(planeInput(), seam.context),
    );

    if (settled.kind !== 'policies') throw new Error('the policies read must settle');
    expect(settled.evaluations).toHaveLength(100);
    expect(settled.evaluationsPartial).toBe(false);
    expect(settled.omittedRowCount).toBe(1);
    expect(settled.projectionTruncated).toBe(true);
    expect(seam.urls.filter((url) => url.includes('/policy/evaluations'))).toHaveLength(2);
    expect(seam.urls.some((url) => url.includes('$skip=100'))).toBe(true);
  });
});

/* ------------------------------------------------------------------- threads */

describe('Azure threads read', () => {
  it('keeps an unanchored remark instead of dropping it', async () => {
    const seam = harness((url) => (
      url.includes('/threads')
        ? collection([
          {
            id: 1,
            status: 'active',
            threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 12 } },
            comments: [{ id: 1, content: 'anchored', author: { displayName: 'Ada' } }],
          },
          {
            id: 2,
            status: 'active',
            // No threadContext at all: a remark about the pull request itself.
            comments: [{ id: 1, content: 'unanchored', author: { displayName: 'Grace' } }],
          },
        ])
        : undefined
    ));

    const settled = AzureThreadsResultV1Schema.parse(
      await readAzureDevOpsThreads(planeInput(), seam.context),
    );
    if (settled.kind !== 'threads') throw new Error('the threads read must settle');
    expect(settled.rows).toHaveLength(2);
    expect(settled.rows[0]?.path).toBe('/src/a.ts');
    expect(settled.rows[1]).not.toHaveProperty('path');
    expect(settled.omittedRowCount).toBe(0);
  });

  it('keeps every admitted embedded comment from the one thread response', async () => {
    const comments = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      content: `reply-${String(index + 1)}`,
      author: { displayName: 'Reviewer' },
    }));
    const seam = harness((url) => (
      url.includes('/threads')
        ? collection([{ id: 1, status: 'active', comments }])
        : undefined
    ));

    const settled = AzureThreadsResultV1Schema.parse(
      await readAzureDevOpsThreads(planeInput(), seam.context),
    );

    if (settled.kind !== 'threads') throw new Error('the threads read must settle');
    expect(settled.rows[0]?.comments).toHaveLength(101);
    expect(settled.rows[0]?.comments[0]?.content).toBe('reply-1');
    expect(settled.rows[0]?.comments.slice(-2).map((comment) => comment.content))
      .toEqual(['reply-100', 'reply-101']);
    expect(settled.rows[0]?.omittedCommentCount).toBe(0);
  });

  it('publishes no cursor, because the documented endpoint issues none', async () => {
    const seam = harness((url) => (url.includes('/threads') ? collection([]) : undefined));
    const settled = AzureThreadsResultV1Schema.parse(
      await readAzureDevOpsThreads(planeInput(), seam.context),
    );
    // A continuation member here would be pagination this product invented.
    expect(settled).not.toHaveProperty('continuation');
    expect(seam.urls[0]).not.toContain('top=');
    expect(seam.urls[0]).not.toContain('continuationToken');
  });

  it('sends the iteration lens with its literal dollar signs', async () => {
    const seam = harness((url) => (url.includes('/threads') ? collection([]) : undefined));
    await readAzureDevOpsThreads(
      planeInput({ iteration: 2, baseIteration: 1 }),
      seam.context,
    );
    // Dropping the `$` is how every thread comes back unfiltered while the
    // caller believes the lens was applied.
    expect(seam.urls[0]).toContain('$iteration=2');
    expect(seam.urls[0]).toContain('$baseIteration=1');
  });

  it('refuses half an iteration lens rather than applying a broken comparison', async () => {
    // The route IS stubbed, so an implementation that silently dropped the
    // half-lens and read unfiltered would settle successfully. That is the
    // outcome this test exists to reject.
    const seam = harness((url) => (url.includes('/threads') ? collection([]) : undefined));
    const settled = AzureThreadsResultV1Schema.parse(
      await readAzureDevOpsThreads(planeInput({ iteration: 2 }), seam.context),
    );
    expect(settled.kind).toBe('unavailable');
    expect(seam.urls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- commits */

describe('Azure commits plane', () => {
  it('carries the continuation token Azure issued in its response header', async () => {
    const seam = harness((url) => (
      url.includes('/commits')
        ? {
          headers: { 'x-ms-continuationtoken': 'opaque-token' },
          body: {
            count: 1,
            value: [{
              commitId: 'c'.repeat(40),
              comment: 'Fix the thing',
              author: { name: 'Ada', date: '2026-08-01T00:00:00Z' },
            }],
          },
        }
        : undefined
    ));

    const settled = AzureCommitsResultV1Schema.parse(
      await listAzureDevOpsCommits(planeInput(), seam.context),
    );
    if (settled.kind !== 'commits') throw new Error('the commits page must settle');
    expect(settled.continuationToken).toBe('opaque-token');
    expect(settled.rows[0]?.comment).toBe('Fix the thing');
    expect(seam.urls[0]).toContain('$top=30');
  });

  it('ends the walk when Azure issues no continuation token', async () => {
    const seam = harness((url) => (url.includes('/commits') ? collection([]) : undefined));
    const settled = AzureCommitsResultV1Schema.parse(
      await listAzureDevOpsCommits(planeInput(), seam.context),
    );
    if (settled.kind !== 'commits') throw new Error('the commits page must settle');
    expect(settled).not.toHaveProperty('continuationToken');
  });
});

/* ----------------------------------------------------------------- admission */

describe('Azure detail admission', () => {
  it('refuses an entry keyed against another deployment before any provider call', async () => {
    const seam = harness(() => undefined);
    const settled = AzureThreadsResultV1Schema.parse(await readAzureDevOpsThreads(planeInput({
      localRef: { ...localRef(), collisionScope: `azure-devops:b3RoZXI:${REPOSITORY_ID}` },
    }), seam.context));
    expect(settled.kind).toBe('unavailable');
    if (settled.kind !== 'unavailable') throw new Error('unreachable');
    expect(settled.failure.code).toBe('azure-devops/entry-outside-configured-instance');
    expect(seam.urls).toHaveLength(0);
  });

  it('does not spend a connectionData request on a detail read', async () => {
    const seam = harness((url) => (url.includes('/threads') ? collection([]) : undefined));
    const settled = AzureThreadsResultV1Schema.parse(
      await readAzureDevOpsThreads(planeInput(), seam.context),
    );
    // The read really happened — otherwise this test would pass by asserting
    // the absence of a request nobody made.
    expect(settled.kind).toBe('threads');
    expect(seam.urls.some((url) => url.includes('/threads'))).toBe(true);
    // No detail plane consumes provider account identity, so paying for it per
    // mounted panel read would buy nothing.
    expect(seam.urls.some((url) => url.includes('connectionData'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ deadline */

describe('the mounted detail deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A provider that accepts the request and then neither answers nor fails.
   * Nothing above this seam can distinguish it from a slow read, which is why
   * the source has to own the bound rather than wait for the transport to.
   */
  function silentHarness(options: Readonly<{ silentListing?: true }> = {}) {
    let aborted = 0;
    const services = {
      connectedAccounts: {
        // The configured-base currentness gate runs BEFORE any provider request, so a
        // harness that could not answer it never reached the deadline path at all and
        // proved nothing about it. `silentListing` is the other half: the LISTING is what
        // never answers, which is the case that would otherwise be reported as a listing
        // that refused rather than as the deadline that actually fired.
        async listAccounts(
          _request: unknown,
          listingOptions?: Readonly<{ signal?: AbortSignal }>,
        ) {
          if (options.silentListing === true) {
            const signal = listingOptions?.signal;
            return await new Promise<never>((_resolve, reject) => {
              if (signal === undefined) return;
              signal.addEventListener('abort', () => {
                aborted += 1;
                reject(signal.reason);
              }, { once: true });
            });
          }
          return {
            status: 'complete' as const,
            accounts: [{
              account: accountRef('account-1'),
              displayName: 'Acme',
              state: 'connected' as const,
              connectedAccountOrigins: ['https://dev.azure.com'],
              connectedAccountBases: [BASE_URL],
            }],
          };
        },
        async getBinding(purpose: string) {
          return {
            purpose,
            service: accountRef('account-1').service,
            account: accountRef('account-1'),
            target: { kind: 'account' as const, displayName: 'Acme' },
          };
        },
        async materializeListedAccount() {
          return { kind: 'httpHeaders' as const, headers: { authorization: 'Basic <pat>' } };
        },
      },
      http: {
        async request(
          _request: Readonly<{ url: string }>,
          options: Readonly<{ signal: AbortSignal }>,
        ) {
          return await new Promise<never>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
              aborted += 1;
              reject(options.signal.reason);
            }, { once: true });
          });
        },
      },
    };
    const context = {
      plugin: { id: 'happier.scm.forge.azure-devops', version: '0.0.0' },
      contribution: { id: 'azure-devops-forge', qualifiedId: 'x/contributions/azure-devops-forge' },
      surface: 'background',
      caller: { kind: 'plugin', pluginId: 'happier.triage' },
      signal: new AbortController().signal,
      services: services as unknown as PluginInvocationContext['services'],
    } as unknown as PluginInvocationContext;
    return { context, abortedCount: () => aborted };
  }

  it('settles a detail read the provider never answers as a classified transient failure', async () => {
    vi.useFakeTimers();
    const seam = silentHarness();

    const settling = readAzureDevOpsIterations(planeInput(), seam.context);
    // Nothing has settled yet: the request is genuinely outstanding, so a pass
    // here would be the assertion racing the read rather than the deadline
    // doing anything.
    const pending = Symbol('pending');
    expect(await Promise.race([settling, Promise.resolve(pending)])).toBe(pending);

    await vi.advanceTimersByTimeAsync(AZURE_DEVOPS_MOUNTED_DETAIL_DEADLINE_MS);

    const settled = AzureIterationsResultV1Schema.parse(await settling);
    if (settled.kind !== 'unavailable') throw new Error('the read must settle unavailable');
    // Not `cancelled`: nobody cancelled it. The reader is still looking at the
    // panel, so the class has to be the retryable one and the code has to say
    // which of the two aborts happened.
    expect(settled.failure.class).toBe('transient');
    expect(settled.failure.code).toBe('azure-devops/timed-out');
    // The deadline aborts the outstanding provider request rather than leaving
    // it running behind a settled result.
    expect(seam.abortedCount()).toBe(1);
  });

  it('classifies a deadline on the Policies preliminary pull-request read as deadline expiry', async () => {
    vi.useFakeTimers();
    const seam = silentHarness();

    const settling = readAzureDevOpsPolicies(planeInput(), seam.context);
    await vi.advanceTimersByTimeAsync(AZURE_DEVOPS_MOUNTED_DETAIL_DEADLINE_MS);

    const settled = AzurePoliciesResultV1Schema.parse(await settling);
    if (settled.kind !== 'unavailable') throw new Error('the read must settle unavailable');
    expect(settled.failure.class).toBe('transient');
    expect(settled.failure.code).toBe('azure-devops/timed-out');
  });

  /**
   * The currentness gate is the FIRST thing every authorized read does, so it is also
   * the first thing a deadline can land on. It reads the Connected Accounts listing, and
   * a listing that never answers looks exactly like one that refused — unless the abort
   * is classified by the same owner every other request already defers to. Reporting it
   * as `account-listing-failed` would tell the reader their accounts are unreadable when
   * what actually happened is that this panel ran out of time.
   */
  it('reports a deadline that lands on the currentness gate as the deadline, not as a listing failure', async () => {
    vi.useFakeTimers();
    const seam = silentHarness({ silentListing: true });

    const settling = readAzureDevOpsIterations(planeInput(), seam.context);
    await vi.advanceTimersByTimeAsync(AZURE_DEVOPS_MOUNTED_DETAIL_DEADLINE_MS);

    const settled = AzureIterationsResultV1Schema.parse(await settling);
    if (settled.kind !== 'unavailable') throw new Error('the read must settle unavailable');
    expect(settled.failure.class).toBe('transient');
    expect(settled.failure.code).toBe('azure-devops/timed-out');
  });

  it('leaves a caller cancellation reported as a cancellation, not as a deadline', async () => {
    vi.useFakeTimers();
    const seam = silentHarness();
    const caller = new AbortController();
    const context = { ...seam.context, signal: caller.signal } as PluginInvocationContext;

    const settling = readAzureDevOpsIterations(planeInput(), context);
    await vi.advanceTimersByTimeAsync(1);
    caller.abort();

    const settled = AzureIterationsResultV1Schema.parse(await settling);
    if (settled.kind !== 'unavailable') throw new Error('the read must settle unavailable');
    expect(settled.failure.code).toBe('azure-devops/cancelled');
  });
});
