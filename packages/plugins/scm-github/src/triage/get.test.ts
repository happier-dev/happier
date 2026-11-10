import { describe, expect, it } from 'vitest';
import { TriageGetResultV1Schema, TriageSourceEntrySnapshotV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

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
  githubChecksBatchResponse,
  readRecordedJsonBody,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';
import { readGithubPullRequest, runGithubTriageGet } from './get.js';
import { toTriageGetResult, toTriageObservation, toTriageScanObservation, toTriageSnapshot } from './mapping/protocol.js';
import { GithubIssueOpeningDetailV1Schema } from './detail/contracts.js';
import { createGithubRepositoryReader } from './repositories.js';
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

/**
 * The SAME repository as `ISSUE_REF`'s collision scope (`github:4210`) reached under a
 * new path, which is what a repository rename produces: the id is unchanged and only
 * the locator is stale.
 */
const RENAMED_REPOSITORY_RESPONSE = Object.freeze({
  ...GITHUB_REPOSITORY_RESPONSE,
  name: 'renamed-app',
  full_name: 'octo-org/renamed-app',
  url: 'https://api.github.com/repos/octo-org/renamed-app',
  html_url: 'https://github.com/octo-org/renamed-app',
});

const RENAMED_ISSUE_RESPONSE = Object.freeze({
  ...GITHUB_ISSUE_RESPONSE,
  number: 7,
  url: 'https://api.github.com/repos/octo-org/renamed-app/issues/7',
  repository_url: 'https://api.github.com/repos/octo-org/renamed-app',
  html_url: 'https://github.com/octo-org/renamed-app/issues/7',
});

async function runGet(input: Readonly<{
  localRef: GithubTriageEntryLocalRefV1;
  routingToken?: unknown;
  respond: (request: RecordedGithubRequest) => StubHttpResponse | undefined;
}>) {
  const transport = createStubGithubTransport({ respond: input.respond });
  const client = await createTestGithubApiClient(transport);
  const { observation } = await runGithubTriageGet(
    {
      localRef: input.localRef,
      routingToken: 'routingToken' in input ? input.routingToken : ROUTING_TOKEN,
    },
    { client, now: fixedClock(1_000), signal: transport.context.signal },
  );
  return { observation, transport };
}

describe('GitHub triage get', () => {
  it('carries the complete already-read PR body only on authoritative get without another body request', async () => {
    const body = `First paragraph.\n\n${'Complete native Markdown.\n'.repeat(1_000)}`;
    const { observation, transport } = await runGet({ localRef: PULL_REQUEST_REF, respond: request => {
      if (request.url.endsWith('/pulls/1284')) return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, body } };
      if (request.url.endsWith('/graphql')) return githubChecksBatchResponse(request);
      return undefined;
    } });
    if (observation.kind !== 'present') throw new Error('Native PR did not resolve');
    const result = TriageGetResultV1Schema.parse(toTriageGetResult(observation, createTriageSourceV1Fixture().configuredInstance));
    expect(result).toMatchObject({ kind: 'present', taskFields: { body } });
    expect(toTriageObservation(observation)).not.toHaveProperty('taskFields');
    expect(toTriageScanObservation(observation)).not.toHaveProperty('taskFields');
    if (result.kind !== 'present') throw new Error('Native PR did not resolve');
    expect(result.snapshot).not.toHaveProperty('summary');
    expect(result.snapshot).not.toHaveProperty('taskCapabilities');
    expect(transport.requests.filter(request => request.url.endsWith('/pulls/1284'))).toHaveLength(1);
    expect(transport.requests.some(request => /\/(?:comments|files|events)(?:\?|$)/u.test(request.url))).toBe(false);
  });

  it.each(['failing', 'running', 'passing', 'empty', 'partial', 'unavailable', 'superseded'] as const)('exposes %s checks through the exact detail result with one counts read', async (state) => {
    const { observation, transport } = await runGet({ localRef: PULL_REQUEST_REF, respond: request => {
      if (request.url.endsWith('/pulls/1284')) return { status: 200, body: {
        ...GITHUB_PULL_REQUEST_RESPONSE,
        head: { ...GITHUB_PULL_REQUEST_RESPONSE.head, sha: 'a'.repeat(40) },
      } };
      if (request.url.endsWith('/graphql')) {
        if (state === 'unavailable') return { status: 403, body: {} };
        return githubChecksBatchResponse(request, state === 'superseded' ? { pullRequest: {
          headRefOid: 'b'.repeat(40), commits: { nodes: [] },
        } } : { nodes: Array.from({ length: state === 'empty' ? 0 : 250 }, () => ({
          __typename: 'CheckRun', status: state === 'running' ? 'IN_PROGRESS' : 'COMPLETED',
          conclusion: state === 'passing' ? 'SUCCESS' : 'FAILURE',
        })), ...(state === 'partial' ? { errors: [{ message: 'Partial checks response', path: ['row0'] }] } : {}) });
      }
      return undefined;
    } });
    const result = TriageGetResultV1Schema.parse(toTriageGetResult(observation, createTriageSourceV1Fixture().configuredInstance));
    expect(result.kind).toBe('present');
    if (result.kind !== 'present') return;
    const checks = result.snapshot.facts.find(fact => fact.id === 'github/checks');
    if (state === 'empty') expect(checks).toBeUndefined();
    else expect(checks).toMatchObject({
      value: state === 'failing' ? { value: '250 failing', tone: 'danger' }
        : state === 'running' ? { value: 'Running', tone: 'info' }
          : state === 'passing' ? { value: 'All passing', tone: 'success' }
          : { value: 'Checks unavailable', tone: 'warning' },
    });
    const reads = transport.requests.filter(request => request.url.endsWith('/graphql'));
    expect(reads).toHaveLength(1);
    const body = readRecordedJsonBody(reads[0]!) as { query: string };
    expect(body.query).toContain('checkRunCountsByState');
    expect(body.query).not.toContain('contexts(first:');
  });

  it('carries complete native issue opening data only through the exact get result', async () => {
    const body = '# Full issue\n' + 'Complete native Markdown.\n'.repeat(1_000);
    const { observation, transport } = await runGet({ localRef: ISSUE_REF,
      respond: request => request.url.endsWith('/issues/7')
        ? { status: 200, body: { ...GITHUB_ISSUE_RESPONSE, body,
          repository_url: `https://api.github.com/repos/${ROUTING_TOKEN}`,
          html_url: `https://github.com/${ROUTING_TOKEN}/issues/7` } }
        : request.url.endsWith('/parent') ? { status: 404, body: {} }
          : request.url.endsWith('/sub_issues') || request.url.endsWith('/blocked_by') ? { status: 200, body: [] }
            : undefined,
    });
    expect(observation.kind).toBe('present');
    if (observation.kind !== 'present') return;
    const result = toTriageGetResult(observation, createTriageSourceV1Fixture().configuredInstance);
    expect(result.kind).toBe('present');
    if (result.kind !== 'present') return;
    const opening = GithubIssueOpeningDetailV1Schema.parse(result.detailData);
    expect(opening.overview).toMatchObject({ kind: 'overview', kindId: 'issue', body });
    expect(opening.capabilities).toMatchObject({ kind: 'capabilities', operations: { issueComment: { kind: 'available' } } });
    expect(transport.requests).toHaveLength(5);
    expect(toTriageObservation(observation)).not.toHaveProperty('detailData');
    expect(toTriageScanObservation(observation)).not.toHaveProperty('detailData');
    expect(GithubIssueOpeningDetailV1Schema.safeParse({ ...opening, credentials: 'not detail data' }).success).toBe(false);
    expect(GithubIssueOpeningDetailV1Schema.safeParse({ ...opening, overview: { kind: 'overview', kindId: 'another-source' } }).success).toBe(false);
  });

  it('offers the repository directory as choices on an exact issue read that asks, and only then', async () => {
    const respond = (request: RecordedGithubRequest): StubHttpResponse | undefined => {
      if (request.url.endsWith('/issues/7')) {
        return { status: 200, body: { ...GITHUB_ISSUE_RESPONSE,
          repository_url: `https://api.github.com/repos/${ROUTING_TOKEN}`,
          html_url: `https://github.com/${ROUTING_TOKEN}/issues/7` } };
      }
      if (request.url.endsWith('/parent')) return { status: 404, body: {} };
      if (request.url.endsWith('/sub_issues') || request.url.endsWith('/blocked_by')) return { status: 200, body: [] };
      if (request.url.includes('/assignees?')) return { status: 200, body: [{ login: 'ada' }, { login: 'grace' }] };
      if (request.url.includes('/labels?')) return { status: 200, body: [{ name: 'bug' }] };
      return undefined;
    };
    const plain = await runGet({ localRef: ISSUE_REF, respond });
    expect(plain.transport.requests.filter(request => request.url.includes('/assignees?') || request.url.includes('/labels?'))).toHaveLength(0);
    expect(plain.observation).not.toHaveProperty('taskFieldChoices');

    const transport = createStubGithubTransport({ respond });
    const client = await createTestGithubApiClient(transport);
    const { observation } = await runGithubTriageGet(
      { localRef: ISSUE_REF, routingToken: ROUTING_TOKEN, includeTaskFieldChoices: true },
      { client, now: fixedClock(1_000), signal: transport.context.signal },
    );
    expect(observation.kind).toBe('present');
    if (observation.kind !== 'present') return;
    const result = toTriageGetResult(observation, createTriageSourceV1Fixture().configuredInstance);
    expect(result).toMatchObject({ taskFieldChoices: {
      assigneeIds: [{ id: 'ada', label: 'ada' }, { id: 'grace', label: 'grace' }],
      labelIds: [{ id: 'bug', label: 'bug' }],
    } });
    expect(toTriageObservation(observation)).not.toHaveProperty('taskFieldChoices');
  });

  it('does not replace a malformed supplied routing token with another route', async () => {
    for (const routingToken of ['', 'https://api.github.com/repos/octo-org/example-app', 'octo-org', 'a/b/c']) {
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
    // An authoritative `get` resolves the diff stat a scan row answers `detailOnly`.
    expect(observation.snapshot.rowFacts.length).toBeGreaterThan(4);
    expect(observation.snapshot.rowFacts.every((fact) => fact.value.kind !== 'detailOnly'))
      .toBe(true);
  });

  it('publishes the pull request\'s head and base branch names from the same read, through the public snapshot', async () => {
    const { observation } = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: (request) => (request.url.endsWith('/pulls/1284')
        ? { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE }
        : undefined),
    });

    expect(observation.kind).toBe('present');
    if (observation.kind !== 'present') return;
    // The strict consumer reads the producer's own public projection, not a hand-built shape.
    const published = TriageSourceEntrySnapshotV1Schema.parse(
      toTriageSnapshot(observation.snapshot, observation.locator, observation.localRef.entryId),
    );
    expect(published.branches).toEqual({ head: 'frame-pump', base: 'main' });
  });

  it('retains the validated provider pull-request number for canonical reread consumers', async () => {
    const transport = createStubGithubTransport({
      respond: (request) => (request.url.endsWith('/pulls/1284')
        ? { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE }
        : undefined),
    });
    const client = await createTestGithubApiClient(transport);
    const reread = await readGithubPullRequest(
      PULL_REQUEST_REF,
      { owner: 'octo-org', name: 'example-app' },
      createGithubRepositoryReader({ client, now: fixedClock(1_000) }),
      { client, now: fixedClock(1_000), signal: transport.context.signal },
    );

    expect(reread).toMatchObject({
      observation: { kind: 'present' },
      facts: { number: 1284 },
    });
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

  it('never concludes absent when the route path now holds a DIFFERENT repository', async () => {
    // A repository can be renamed, deleted and recreated at the same `owner/name`
    // path. The confirming read then answers `200` for an occupant that is not the
    // repository this entry belongs to, so a bare readability proof turns a stale
    // locator into an authoritative "this pull request no longer exists".
    const reoccupied = { ...GITHUB_REPOSITORY_RESPONSE, id: 99001 };

    const pullRequest = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: (request) => (request.url.includes('/pulls/')
        ? { status: 404, body: { message: 'Not Found' } }
        : { status: 200, body: reoccupied }),
    });
    const issue = await runGet({
      localRef: ISSUE_REF,
      respond: (request) => (request.url.includes('/issues/')
        ? { status: 410, body: { message: 'Gone' } }
        : { status: 200, body: reoccupied }),
    });

    expect(pullRequest.observation.kind).toBe('unresolved');
    expect(pullRequest.observation.kind === 'unresolved'
      && pullRequest.observation.failure.code).toBe('route-body-mismatch');
    expect(issue.observation.kind).toBe('unresolved');
    expect(issue.observation.kind === 'unresolved'
      && issue.observation.failure.code).toBe('route-body-mismatch');
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

  it('follows the numeric repository redirect a renamed repository actually returns', async () => {
    // Observed 2026-09-05: `GET /repos/{oldOwner}/{oldRepo}/issues/{n}` on a renamed
    // repository answers `301` with `Location: .../repositories/{id}/issues/{n}` — a
    // numeric route, not a `/repos/...` one. Refusing that grammar refuses the only
    // recovery this entry has.
    const { observation, transport } = await runGet({
      localRef: ISSUE_REF,
      respond: (request) => {
        if (request.url.endsWith('/repos/octo-org/example-app/issues/7')) {
          return {
            status: 301,
            headers: { Location: 'https://api.github.com/repositories/4210/issues/7' },
          };
        }
        if (request.url.endsWith('/repositories/4210/issues/7')) {
          return { status: 200, body: RENAMED_ISSUE_RESPONSE };
        }
        if (request.url.endsWith('/repos/octo-org/renamed-app')) {
          return { status: 200, body: RENAMED_REPOSITORY_RESPONSE };
        }
        return undefined;
      },
    });

    // Same repository id and same number: this is a locator refresh, not a successor.
    // Emitting `merged` with the entry as its own successor leaves the row unresolved
    // forever, because merged is never folded as present.
    expect(observation.kind).toBe('present');
    if (observation.kind !== 'present') return;
    expect(observation.localRef).toEqual(ISSUE_REF);
    expect(observation.locator.routingToken).toBe('octo-org/renamed-app');
    expect(observation.locator.displayPath).toBe('octo-org/renamed-app#7');
    expect(transport.requests[0]?.redirect).toBe('manual');
    expect(transport.requests.filter((request) => request.redirect === 'manual')).toHaveLength(1);
  });

  it('refreshes the locator rather than merging when a named redirect keeps the identity', async () => {
    const { observation } = await runGet({
      localRef: ISSUE_REF,
      respond: (request) => {
        if (request.url.endsWith('/repos/octo-org/example-app/issues/7')) {
          return {
            status: 301,
            headers: { Location: 'https://api.github.com/repos/octo-org/renamed-app/issues/7' },
          };
        }
        if (request.url.endsWith('/repos/octo-org/renamed-app/issues/7')) {
          return { status: 200, body: RENAMED_ISSUE_RESPONSE };
        }
        if (request.url.endsWith('/repos/octo-org/renamed-app')) {
          return { status: 200, body: RENAMED_REPOSITORY_RESPONSE };
        }
        return undefined;
      },
    });

    expect(observation.kind).toBe('present');
    if (observation.kind !== 'present') return;
    expect(observation.localRef).toEqual(ISSUE_REF);
    expect(observation.locator.routingToken).toBe('octo-org/renamed-app');
  });

  it('refuses a numeric redirect whose destination repository is not the one it named', async () => {
    // The numeric route asserts a repository id. A destination body that resolves to a
    // different repository is not that repository, and following it would rekey the
    // entry onto an unrelated one.
    const { observation } = await runGet({
      localRef: ISSUE_REF,
      respond: (request) => {
        if (request.url.endsWith('/repos/octo-org/example-app/issues/7')) {
          return {
            status: 301,
            headers: { Location: 'https://api.github.com/repositories/4210/issues/7' },
          };
        }
        if (request.url.endsWith('/repositories/4210/issues/7')) {
          return { status: 200, body: RENAMED_ISSUE_RESPONSE };
        }
        if (request.url.endsWith('/repos/octo-org/renamed-app')) {
          return { status: 200, body: GITHUB_OTHER_REPOSITORY_RESPONSE };
        }
        return undefined;
      },
    });

    expect(observation).toEqual({
      kind: 'unresolved',
      localRef: ISSUE_REF,
      failure: { class: 'unknown', code: 'route-body-mismatch' },
    });
  });

  it('refuses a numeric redirect whose destination body names no repository at all', async () => {
    // A numeric route carries no owner/name, so the destination body is the ONLY
    // source of the locator. Substituting the old path would republish a locator the
    // redirect just said was stale.
    const withoutRepository = Object.fromEntries(
      Object.entries(RENAMED_ISSUE_RESPONSE).filter(([key]) => key !== 'repository_url'),
    );
    const { observation } = await runGet({
      localRef: ISSUE_REF,
      respond: (request) => {
        if (request.url.endsWith('/repos/octo-org/example-app/issues/7')) {
          return {
            status: 301,
            headers: { Location: 'https://api.github.com/repositories/4210/issues/7' },
          };
        }
        return request.url.endsWith('/repositories/4210/issues/7')
          ? { status: 200, body: withoutRepository }
          : undefined;
      },
    });

    expect(observation).toEqual({
      kind: 'unresolved',
      localRef: ISSUE_REF,
      failure: { class: 'unknown', code: 'route-body-mismatch' },
    });
  });

  it('rejects a cross-origin, malformed, same-route, or non-issue redirect without following it', async () => {
    const locations = [
      'https://evil.example.com/repos/octo-org/example-tools/issues/41',
      'not a url at all',
      'https://api.github.com/repos/octo-org/example-app/issues/7',
      'https://api.github.com/repos/octo-org/example-tools/pulls/41',
      'https://api.github.com/repos/octo-org/example-tools/issues/41?token=x',
      'https://api.github.com/repos/octo-org/example-tools/issues/0',
      // The numeric grammar is admitted, but not loosened: a non-positive or
      // non-decimal repository id, a non-issue collection, and a bad number are the
      // same refusal they are on the named route.
      'https://api.github.com/repositories/0/issues/41',
      'https://api.github.com/repositories/abc/issues/41',
      'https://api.github.com/repositories/4210/pulls/41',
      'https://api.github.com/repositories/4210/issues/0',
      'https://api.github.com/repositories/4210/issues/41#fragment',
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
      detail: 'pull_requests=read',
      requiredPermissions: 'pull_requests=read',
    });
  });

  it('reports mergeability computing as a real state rather than unresolved', async () => {
    const computing = await runGet({
      localRef: PULL_REQUEST_REF,
      respond: () => ({
        status: 200,
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
      .toEqual({ kind: 'status', value: 'Computing', tone: 'info' });
    expect(readMergeability(conflicts.observation))
      .toEqual({ kind: 'status', value: 'Conflicts', tone: 'danger' });
    expect(readMergeability(clean.observation)).toBeUndefined();
  });
});
