import { MAX_TRIAGE_ROW_FACTS_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  GITHUB_ISSUE_RESPONSE,
  GITHUB_OTHER_REPOSITORY_RESPONSE,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_REPOSITORY_RESPONSE,
  GITHUB_TRANSFERRED_ISSUE_RESPONSE,
} from './__fixtures__/githubResponses.js';
import {
  createStubGithubTransport,
  createTestGithubApiClient,
  fixedClock,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';
import { runGithubTriageGet } from './get.js';
import type { GithubTriageEntryLocalRefV1 } from './types.js';

const PULL_REQUEST_REF: GithubTriageEntryLocalRefV1 = Object.freeze({
  kindId: 'pull-request',
  collisionScope: 'github:4210',
  entryId: '1284',
});

const ISSUE_REF: GithubTriageEntryLocalRefV1 = Object.freeze({
  kindId: 'issue',
  collisionScope: 'github:4210',
  entryId: '7',
});

const ROUTING_TOKEN = 'octo-org/example-app';

async function runGet(input: Readonly<{
  localRef: GithubTriageEntryLocalRefV1;
  routingToken?: unknown;
  respond: (request: RecordedGithubRequest) => StubHttpResponse | undefined;
}>) {
  const transport = createStubGithubTransport({ respond: input.respond });
  const client = await createTestGithubApiClient(transport);
  const observation = await runGithubTriageGet(
    {
      localRef: input.localRef,
      routingToken: 'routingToken' in input ? input.routingToken : ROUTING_TOKEN,
    },
    { client, now: fixedClock(1_000), signal: transport.context.signal },
  );
  return { observation, transport };
}

describe('GitHub triage get', () => {
  it('does not synthesize a locator when the stored routing token is missing or malformed', async () => {
    for (const routingToken of [null, '', 'https://api.github.com/repos/octo-org/example-app', 'octo-org', 'a/b/c']) {
      const { observation, transport } = await runGet({
        localRef: PULL_REQUEST_REF,
        routingToken,
        respond: () => {
          throw new Error('a missing locator must not produce an outbound API call');
        },
      });

      expect(transport.requests).toHaveLength(0);
      expect(observation).toEqual({
        kind: 'unresolved',
        localRef: PULL_REQUEST_REF,
        failure: { class: 'unknown', code: 'github_locator_unusable' },
      });
    }
  });

  it('returns present only when the route body number and repository scope both match', async () => {
    const { observation } = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: (request) => (request.url.endsWith('/pulls/1284')
        ? { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE }
        : undefined),
    });

    expect(observation.kind).toBe('present');
    if (observation.kind !== 'present') return;
    expect(observation.localRef).toEqual(PULL_REQUEST_REF);
    expect(observation.snapshot.nativeRevision)
      .toBe('9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29');
    // An authoritative `get` resolves the diff stat a scan row answers `detailOnly`,
    // and the row it projects stays inside the published fact count. Which facts a
    // bounded row keeps is `mapping/facts.ts`'s contract and is tested there.
    expect(observation.snapshot.rowFacts.length).toBeLessThanOrEqual(MAX_TRIAGE_ROW_FACTS_V1);
    expect(observation.snapshot.rowFacts.every((fact) => fact.value.kind !== 'detailOnly'))
      .toBe(true);
  });

  it('keeps a 200 whose repository scope differs unresolved, never present', async () => {
    const { observation } = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({
        status: 200,
        body: {
          ...GITHUB_PULL_REQUEST_RESPONSE,
          base: {
            ...(GITHUB_PULL_REQUEST_RESPONSE.base as Record<string, unknown>),
            repo: { ...GITHUB_OTHER_REPOSITORY_RESPONSE },
          },
        },
      }),
    });

    expect(observation).toEqual({
      kind: 'unresolved',
      localRef: PULL_REQUEST_REF,
      failure: { class: 'unknown', code: 'route-body-mismatch' },
    });
  });

  it('keeps a 200 whose number differs unresolved, never present', async () => {
    const { observation } = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({ status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, number: 1285 } }),
    });

    expect(observation.kind).toBe('unresolved');
    if (observation.kind !== 'unresolved') return;
    expect(observation.failure.code).toBe('route-body-mismatch');
  });

  it('treats a 404 without a readable repository as unresolved, never absent', async () => {
    const { observation } = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: (request) => (request.url.includes('/pulls/')
        ? { status: 404, body: { message: 'Not Found' } }
        : { status: 404, body: { message: 'Not Found' } }),
    });

    expect(observation.kind).toBe('unresolved');
    expect(observation.kind === 'unresolved' && observation.failure.class).toBe('unknown');
  });

  it('concludes absent for a pull request only on 404 with a readable repository', async () => {
    const { observation, transport } = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: (request) => (request.url.includes('/pulls/')
        ? { status: 404, body: { message: 'Not Found' } }
        : { status: 200, body: GITHUB_REPOSITORY_RESPONSE }),
    });

    // The confirming repository read is a private proof step, not emitted metadata.
    expect(transport.requests).toHaveLength(2);
    expect(observation).toEqual({ kind: 'absent', localRef: PULL_REQUEST_REF });
    expect(Object.keys(observation)).toEqual(['kind', 'localRef']);
  });

  it('treats an issue 404 as unresolved even when the old repository reads 200', async () => {
    const { observation } = await runGet({
      localRef: ISSUE_REF,
      respond: (request) => (request.url.includes('/issues/')
        ? { status: 404, body: { message: 'Not Found' } }
        : { status: 200, body: GITHUB_REPOSITORY_RESPONSE }),
    });

    expect(observation.kind).toBe('unresolved');
    expect(observation).not.toEqual({ kind: 'absent', localRef: ISSUE_REF });
  });

  it('concludes absent for an issue only on 410 with a readable repository', async () => {
    const gone = await runGet({
      localRef: ISSUE_REF,
      respond: (request) => (request.url.includes('/issues/')
        ? { status: 410, body: { message: 'Gone' } }
        : { status: 200, body: GITHUB_REPOSITORY_RESPONSE }),
    });
    const goneUnreadable = await runGet({
      localRef: ISSUE_REF,
      respond: () => ({ status: 410, body: { message: 'Gone' } }),
    });

    expect(gone.observation).toEqual({ kind: 'absent', localRef: ISSUE_REF });
    expect(goneUnreadable.observation.kind).toBe('unresolved');
  });

  it('follows one validated same-origin issue 301 and accepts the destination route own number', async () => {
    const { observation, transport } = await runGet({
      localRef: ISSUE_REF,
      respond: (request) => {
        if (request.url.endsWith('/repos/octo-org/example-app/issues/7')) {
          return {
            status: 301,
            headers: {
              Location: 'https://api.github.com/repos/octo-org/example-tools/issues/41',
            },
          };
        }
        if (request.url.endsWith('/repos/octo-org/example-tools/issues/41')) {
          return { status: 200, body: GITHUB_TRANSFERRED_ISSUE_RESPONSE };
        }
        if (request.url.endsWith('/repos/octo-org/example-tools')) {
          return { status: 200, body: GITHUB_OTHER_REPOSITORY_RESPONSE };
        }
        return undefined;
      },
    });

    expect(observation).toEqual({
      kind: 'merged',
      localRef: ISSUE_REF,
      successor: { kindId: 'issue', collisionScope: 'github:8815', entryId: '41' },
    });
    expect(transport.requests[0]?.redirect).toBe('manual');
    expect(transport.requests.filter((request) => request.redirect === 'manual')).toHaveLength(1);
  });

  it('rejects a cross-origin, malformed, same-route, or non-issue redirect without following it', async () => {
    const locations = [
      'https://evil.example.com/repos/octo-org/example-tools/issues/41',
      'not a url at all',
      'https://api.github.com/repos/octo-org/example-app/issues/7',
      'https://api.github.com/repos/octo-org/example-tools/pulls/41',
      'https://api.github.com/repos/octo-org/example-tools/issues/41?token=x',
      'https://api.github.com/repos/octo-org/example-tools/issues/0',
    ];

    for (const location of locations) {
      const { observation, transport } = await runGet({
        localRef: ISSUE_REF,
        respond: (request) => (request.url.endsWith('/issues/7')
          ? { status: 301, headers: { location } }
          : undefined),
      });

      expect(observation).toEqual({
        kind: 'unresolved',
        localRef: ISSUE_REF,
        failure: { class: 'unknown', code: 'route-body-mismatch' },
      });
      expect(transport.requests).toHaveLength(1);
    }
  });

  it('keeps a bare issue 200 scope mismatch unresolved, never merged', async () => {
    for (const body of [
      { ...GITHUB_ISSUE_RESPONSE, number: 7 },
      { ...GITHUB_ISSUE_RESPONSE, number: 41 },
    ]) {
      const { observation } = await runGet({
        localRef: ISSUE_REF,
        respond: (request) => (request.url.includes('/issues/')
          ? { status: 200, body }
          : { status: 200, body: GITHUB_OTHER_REPOSITORY_RESPONSE }),
      });

      expect(observation.kind).toBe('unresolved');
      expect(observation.kind === 'unresolved' && observation.failure.code)
        .toBe('route-body-mismatch');
    }
  });

  it('reports a rate limit as unresolved with the provider-directed absolute retry instant', async () => {
    const { observation } = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({ status: 429, body: { message: 'API rate limit exceeded' } }),
    });

    expect(observation).toEqual({
      kind: 'unresolved',
      localRef: PULL_REQUEST_REF,
      failure: {
        class: 'rateLimit',
        code: 'github_rate_limited',
        retryNotBeforeMs: 61_000,
      },
    });
  });

  it('reports an authentication failure distinctly from a permission failure', async () => {
    const unauthorized = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({ status: 401, body: { message: 'Bad credentials' } }),
    });
    const forbidden = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({
        status: 403,
        headers: { 'x-accepted-github-permissions': 'pull_requests=read' },
        body: { message: 'Resource not accessible' },
      }),
    });

    expect(unauthorized.observation.kind === 'unresolved'
      && unauthorized.observation.failure.class).toBe('authentication');
    expect(forbidden.observation.kind === 'unresolved'
      && forbidden.observation.failure).toEqual({
      class: 'permission',
      code: 'insufficient_scope',
    });
  });

  it('reports mergeability computing as a real state rather than unresolved', async () => {
    const computing = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({
        status: 200,
        // A pull request with no author frees a row slot, so the mergeability fact
        // this test is about is inside the published fact count rather than bounded
        // out of the row by generic metadata.
        body: {
          ...GITHUB_PULL_REQUEST_RESPONSE,
          user: null,
          mergeable: null,
          mergeable_state: 'unknown',
        },
      }),
    });
    const conflicts = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({
        status: 200,
        body: {
          ...GITHUB_PULL_REQUEST_RESPONSE,
          user: null,
          mergeable: false,
          mergeable_state: 'dirty',
        },
      }),
    });
    const clean = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({
        status: 200,
        body: { ...GITHUB_PULL_REQUEST_RESPONSE, user: null },
      }),
    });

    const readMergeability = (observation: typeof computing.observation) =>
      (observation.kind === 'present'
        ? observation.snapshot.rowFacts.find((fact) => fact.id === 'github/mergeability')?.value
        : undefined);

    expect(readMergeability(computing.observation))
      .toEqual({ kind: 'status', label: 'Computing', tone: 'info' });
    expect(readMergeability(conflicts.observation))
      .toEqual({ kind: 'status', label: 'Conflicts', tone: 'danger' });
    expect(readMergeability(clean.observation)).toBeUndefined();
  });
});
