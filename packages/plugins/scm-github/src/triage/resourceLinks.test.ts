import { describe, expect, it } from 'vitest';
import { parseGithubResourceUrl } from './locator.js';
import { resolveGithubResourceEntry } from './resourceLinks.js';
import { GITHUB_REPOSITORY_RESPONSE } from './__fixtures__/githubResponses.js';
import { createStubGithubTransport, createTestGithubApiClient, fixedClock } from './testkit/githubTriage.test-support.js';

describe('GitHub resource links', () => {
  it.each([
    ['pullRequest', 'pull/1284', 'pull-request', '1284'],
    ['issue', 'issues/7', 'issue', '7'],
    ['ciRun', 'actions/runs/42', null, '42'],
    ['securityAlert', 'security/dependabot/9', 'dependabot-alert', '9'],
    ['securityAlert', 'security/code-scanning/8', 'code-scanning-alert', '8'],
  ])('recognizes %s through its exact GitHub route', (kind, path, kindId, number) => {
    expect(parseGithubResourceUrl({ kind, url: `https://github.com/Octo-org/example-app/${path}?tab=checks#anchor` }))
      .toEqual({ owner: 'octo-org', name: 'example-app', kindId, number });
  });

  it.each([
    { kind: 'issue', url: 'https://github.com/octo-org/example-app/pull/7' },
    { kind: 'pullRequest', url: 'https://github.com.evil.test/octo-org/example-app/pull/7' },
    { kind: 'pullRequest', url: 'https://user:secret@github.com/octo-org/example-app/pull/7' },
    { kind: 'pullRequest', url: 'http://github.com/octo-org/example-app/pull/7' },
    { kind: 'pullRequest', url: 'https://github.com/octo-org/example-app/pull/0' },
  ])('refuses a mismatched or unsupported resource', resource => {
    expect(parseGithubResourceUrl(resource)).toBeNull();
  });

  it('resolves the repository database identity without scanning entries', async () => {
    const transport = createStubGithubTransport({ respond: request => request.url.endsWith('/repos/octo-org/example-app')
      ? { status: 200, body: GITHUB_REPOSITORY_RESPONSE } : undefined });
    const client = await createTestGithubApiClient(transport);
    expect(await resolveGithubResourceEntry({ kind: 'pullRequest', url: 'https://github.com/octo-org/example-app/pull/1284' },
      { client, now: fixedClock(1000) })).toEqual({ kind: 'resolved',
      localRef: { kindId: 'pull-request', collisionScope: 'github:4210', entryId: '1284' },
      locator: { v: 1, routingToken: 'octo-org/example-app', displayPath: 'octo-org/example-app#1284',
        webUrl: 'https://github.com/octo-org/example-app/pull/1284' } });
    expect(transport.requests.map(request => new URL(request.url).pathname)).toEqual(['/repos/octo-org/example-app']);
  });

  it('keeps a masked repository denial unavailable rather than inventing an entry', async () => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 404, body: { message: 'Not Found' } }) });
    const client = await createTestGithubApiClient(transport);
    expect(await resolveGithubResourceEntry({ kind: 'issue', url: 'https://github.com/octo-org/example-app/issues/7' },
      { client, now: fixedClock(1000) })).toMatchObject({ kind: 'unavailable', failure: { class: 'unknown' } });
  });
});
