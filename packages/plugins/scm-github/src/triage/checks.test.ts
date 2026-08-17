import { describe, expect, it } from 'vitest';

import {
  githubCheckRun,
  githubCheckRunsResponse,
  githubCombinedStatusResponse,
  githubCommitStatus,
} from './__fixtures__/githubResponses.js';
import {
  createStubGithubTransport,
  createTestGithubApiClient,
  fixedClock,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';
import { readGithubPullRequestChecks } from './checks.js';

const ROUTE = Object.freeze({ owner: 'octo-org', name: 'example-app' });
const HEAD_SHA = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';

async function readChecks(
  respond: (request: RecordedGithubRequest) => StubHttpResponse | undefined,
) {
  const transport = createStubGithubTransport({ respond });
  const client = await createTestGithubApiClient(transport);
  const surface = await readGithubPullRequestChecks(
    { route: ROUTE, headSha: HEAD_SHA },
    { client, now: fixedClock(1_000), signal: transport.context.signal },
  );
  return { surface, transport };
}

function emptyStatus(): StubHttpResponse {
  return { status: 200, body: githubCombinedStatusResponse({ state: 'success', statuses: [] }) };
}

describe('GitHub pull-request checks', () => {
  it('reads both the check runs and the commit statuses, each on its own request', async () => {
    const { transport } = await readChecks((request) => (request.url.includes('/check-runs')
      ? { status: 200, body: githubCheckRunsResponse({ runs: [] }) }
      : emptyStatus()));

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.some((request) => request.url.includes('/check-runs?filter=all')))
      .toBe(true);
    expect(transport.requests.some((request) => request.url.endsWith('/status?per_page=100')))
      .toBe(true);
  });

  it('keys matrix check runs distinctly when name and url collide', async () => {
    const { surface } = await readChecks((request) => (request.url.includes('/check-runs')
      ? {
        status: 200,
        body: githubCheckRunsResponse({
          runs: [
            githubCheckRun({ id: 9_001, name: 'build', status: 'completed', conclusion: 'success' }),
            githubCheckRun({ id: 9_002, name: 'build', status: 'completed', conclusion: 'failure' }),
          ],
        }),
      }
      : emptyStatus()));

    expect(surface.observations.map((observation) => observation.key)).toEqual([
      'github-check-run:9001',
      'github-check-run:9002',
    ]);
    expect(surface.failingCount).toBe(1);
    expect(surface.rowState).toEqual({ kind: 'failing', failingCount: 1 });
  });

  it('qualifies a check run and a commit status that share a numeric id', async () => {
    const { surface } = await readChecks((request) => (request.url.includes('/check-runs')
      ? {
        status: 200,
        body: githubCheckRunsResponse({
          runs: [githubCheckRun({ id: 42, name: 'build', status: 'completed', conclusion: 'success' })],
        }),
      }
      : {
        status: 200,
        body: githubCombinedStatusResponse({
          state: 'success',
          statuses: [githubCommitStatus({ id: 42, context: 'legacy/ci', state: 'success' })],
        }),
      }));

    expect(surface.observations.map((observation) => observation.key)).toEqual([
      'github-check-run:42',
      'github-commit-status:42',
    ]);
  });

  it('renders no-checks, unknown-checks, and known-incomplete-checks as different states', async () => {
    const none = await readChecks((request) => (request.url.includes('/check-runs')
      ? { status: 200, body: githubCheckRunsResponse({ runs: [] }) }
      : emptyStatus()));
    const unknown = await readChecks((request) => (request.url.includes('/check-runs')
      ? { status: 403, body: { message: 'Resource not accessible' } }
      : emptyStatus()));
    const incomplete = await readChecks((request) => (request.url.includes('/check-runs')
      ? {
        status: 200,
        body: githubCheckRunsResponse({
          runs: [githubCheckRun({ id: 1, name: 'build', status: 'completed', conclusion: 'success' })],
          totalCount: 4_200,
        }),
      }
      : emptyStatus()));

    expect(none.surface.state).toBe('none');
    expect(none.surface.rowState).toBeNull();
    // Absent is never zero: with nothing to break down, the counts are null, not 0.
    expect(none.surface.failingCount).toBeNull();

    expect(unknown.surface.state).toBe('unknown');
    expect(unknown.surface.checkRunsFailure).toEqual({
      class: 'permission',
      code: 'github_forbidden',
    });
    expect(unknown.surface.failingCount).toBeNull();

    expect(incomplete.surface.state).toBe('knownIncomplete');
    expect(incomplete.surface.observations).toHaveLength(1);
  });

  it('reports a check walk stopped by its own page budget as known-incomplete', async () => {
    // Every page advertises another page, so the walk exhausts its page budget while
    // GitHub is still offering rows. `total_count` stays small and honest, so the
    // ceiling signal never fires: exhaustion is the only evidence that the list is
    // short, and without it a truncated read renders as a settled rollup.
    const pages: number[] = [];
    const { surface } = await readChecks((request) => {
      if (!request.url.includes('/check-runs')) return emptyStatus();
      const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
      pages.push(page);
      return {
        status: 200,
        headers: {
          link: '<https://api.github.com/repos/octo-org/example-app/commits/'
            + `${HEAD_SHA}/check-runs?filter=all&per_page=100&page=${page + 1}>; rel="next"`,
        },
        body: githubCheckRunsResponse({
          runs: [githubCheckRun({
            id: page,
            name: `job-${page}`,
            status: 'completed',
            conclusion: 'success',
          })],
          totalCount: 12,
        }),
      };
    });

    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(surface.observations).toHaveLength(10);
    expect(surface.checkRunsFailure).toBeNull();
    expect(surface.state).toBe('knownIncomplete');
  });

  it('reports a truncated commit-status walk as known-incomplete', async () => {
    // The combined-status envelope gives this source no total to compare against a
    // ceiling, so exhaustion is its ONLY incompleteness evidence. A check-runs walk
    // that ended cleanly must not settle the surface on its sibling's behalf.
    const { surface } = await readChecks((request) => {
      if (request.url.includes('/check-runs')) {
        return { status: 200, body: githubCheckRunsResponse({ runs: [] }) };
      }
      const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
      return {
        status: 200,
        headers: {
          link: '<https://api.github.com/repos/octo-org/example-app/commits/'
            + `${HEAD_SHA}/status?per_page=100&page=${page + 1}>; rel="next"`,
        },
        body: githubCombinedStatusResponse({
          state: 'success',
          statuses: [githubCommitStatus({ id: page, context: `legacy/ci-${page}`, state: 'success' })],
        }),
      };
    });

    expect(surface.observations).toHaveLength(10);
    expect(surface.commitStatusFailure).toBeNull();
    expect(surface.state).toBe('knownIncomplete');
  });

  it('keeps the surviving read visible when only one of the two reads fails', async () => {
    const { surface } = await readChecks((request) => (request.url.includes('/check-runs')
      ? {
        status: 200,
        body: githubCheckRunsResponse({
          runs: [githubCheckRun({ id: 7, name: 'build', status: 'in_progress' })],
        }),
      }
      : { status: 500, body: { message: 'Server Error' } }));

    expect(surface.observations).toHaveLength(1);
    expect(surface.state).toBe('unknown');
    expect(surface.commitStatusFailure).toEqual({
      class: 'transient',
      code: 'github_server_error',
    });
    expect(surface.checkRunsFailure).toBeNull();
  });

  it('projects running and all-passing rollups from the two resources together', async () => {
    const running = await readChecks((request) => (request.url.includes('/check-runs')
      ? {
        status: 200,
        body: githubCheckRunsResponse({
          runs: [githubCheckRun({ id: 1, name: 'build', status: 'in_progress' })],
        }),
      }
      : emptyStatus()));
    const passing = await readChecks((request) => (request.url.includes('/check-runs')
      ? {
        status: 200,
        body: githubCheckRunsResponse({
          runs: [
            githubCheckRun({ id: 1, name: 'build', status: 'completed', conclusion: 'success' }),
            githubCheckRun({ id: 2, name: 'lint', status: 'completed', conclusion: 'skipped' }),
          ],
        }),
      }
      : {
        status: 200,
        body: githubCombinedStatusResponse({
          state: 'success',
          statuses: [githubCommitStatus({ id: 5, context: 'legacy/ci', state: 'success' })],
        }),
      }));

    expect(running.surface.rowState).toEqual({ kind: 'running' });
    expect(passing.surface.rowState).toEqual({ kind: 'allPassing' });
    expect(passing.surface.passingCount).toBe(2);
  });

  it('refuses a check-runs next link that changes the request rather than following it', async () => {
    const { surface, transport } = await readChecks((request) => (request.url.includes('/check-runs')
      ? {
        status: 200,
        headers: {
          link: '<https://api.github.com/repos/octo-org/example-app/commits/'
            + `${HEAD_SHA}/check-runs?filter=latest&per_page=100&page=2>; rel="next"`,
        },
        body: githubCheckRunsResponse({ runs: [] }),
      }
      : emptyStatus()));

    expect(transport.requests.filter((request) => request.url.includes('/check-runs')))
      .toHaveLength(1);
    expect(surface.checkRunsFailure).toEqual({
      class: 'unsupportedContract',
      code: 'github_checks_link_invalid',
    });
  });

  it('follows a check-runs next link that only advances the page', async () => {
    const pages: string[] = [];
    const { surface } = await readChecks((request) => {
      if (!request.url.includes('/check-runs')) return emptyStatus();
      const page = new URL(request.url).searchParams.get('page') ?? '1';
      pages.push(page);
      if (page === '1') {
        return {
          status: 200,
          headers: {
            link: '<https://api.github.com/repos/octo-org/example-app/commits/'
              + `${HEAD_SHA}/check-runs?filter=all&per_page=100&page=2>; rel="next"`,
          },
          body: githubCheckRunsResponse({
            runs: [githubCheckRun({ id: 1, name: 'a', status: 'completed', conclusion: 'success' })],
          }),
        };
      }
      return {
        status: 200,
        body: githubCheckRunsResponse({
          runs: [githubCheckRun({ id: 2, name: 'b', status: 'completed', conclusion: 'success' })],
        }),
      };
    });

    expect(pages).toEqual(['1', '2']);
    expect(surface.observations.map((observation) => observation.key)).toEqual([
      'github-check-run:1',
      'github-check-run:2',
    ]);
  });
});
