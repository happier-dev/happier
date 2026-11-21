import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createStubGithubTransport, createTestGithubApiClient } from '../triage/testkit/githubTriage.test-support.js';
import { GITHUB_OVERVIEW_TARGET_ACTIONS_V1, readGithubOverviewTargetV1 } from './overview.js';
import { GITHUB_OVERVIEW_TARGET_ACTION_ID } from './overviewContracts.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' } as const;
const headSha = 'a'.repeat(40);

describe('GitHub Overview default-branch target', () => {
  it('preserves the credential owner remedy and phase through the Action failure carrier', async () => {
    const failure = new PluginError({ code: 'plugin_connected_account_native_unavailable',
      remediation: { kind: 'selectAccount', service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' } },
      failureCause: { phase: 'connected_account.materialize', errorClass: 'PluginError',
        errorCode: 'plugin_connected_account_native_unavailable', httpStatus: null } });
    const transport = createStubGithubTransport({ nativeMaterialization: () => { throw failure; },
      respond: () => { throw new Error('Credential refusal must precede provider HTTP'); } });
    await expect(GITHUB_OVERVIEW_TARGET_ACTIONS_V1[GITHUB_OVERVIEW_TARGET_ACTION_ID].run({ repository }, transport.context))
      .rejects.toBe(failure);
    expect(transport.requests).toEqual([]);
  });

  it('resolves the actual default branch through its exact ref, without a run, workflow or Contents read', async () => {
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer test-only-placeholder' } },
      respond(request) {
      if (request.url === 'https://api.github.com/repos/octo-org/example-app') return { status: 200,
        body: { full_name: 'octo-org/example-app', default_branch: 'release/current' } };
      if (request.url.endsWith('/commits/release%2Fcurrent')) return { status: 200, body: { sha: headSha } };
      return undefined;
    } });
    expect(await GITHUB_OVERVIEW_TARGET_ACTIONS_V1[GITHUB_OVERVIEW_TARGET_ACTION_ID].run({ repository }, transport.context))
      .toEqual({ kind: 'value', value: { repository, branch: 'release/current', headSha } });
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://api.github.com/repos/octo-org/example-app',
      'https://api.github.com/repos/octo-org/example-app/commits/release%2Fcurrent',
    ]);
  });

  it('returns the native authentication failure without starting any CI reads', async () => {
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer test-only-placeholder' } },
      respond: () => ({ status: 401 }),
    });
    expect(await GITHUB_OVERVIEW_TARGET_ACTIONS_V1[GITHUB_OVERVIEW_TARGET_ACTION_ID].run({ repository }, transport.context))
      .toEqual({ kind: 'unavailable', failure: { class: 'authentication', code: 'github_unauthorized' } });
    expect(transport.requests).toHaveLength(1);
  });

  it('resolves the requested linked branch instead of substituting the default branch', async () => {
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer test-only-placeholder' } },
      respond(request) {
        if (request.url === 'https://api.github.com/repos/octo-org/example-app') return { status: 200,
          body: { full_name: 'octo-org/example-app', default_branch: 'other' } };
        if (request.url.endsWith('/commits/release%2Fcurrent')) return { status: 200, body: { sha: headSha } };
        return undefined;
      },
    });
    expect(await GITHUB_OVERVIEW_TARGET_ACTIONS_V1[GITHUB_OVERVIEW_TARGET_ACTION_ID].run(
      { repository, ref: 'release/current' }, transport.context,
    )).toEqual({ kind: 'value', value: { repository, branch: 'release/current', headSha } });
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://api.github.com/repos/octo-org/example-app',
      'https://api.github.com/repos/octo-org/example-app/commits/release%2Fcurrent',
    ]);
  });

  it('reports an unavailable linked branch without resolving the default branch', async () => {
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer test-only-placeholder' } },
      respond(request) {
        if (request.url === 'https://api.github.com/repos/octo-org/example-app') return { status: 200,
          body: { full_name: 'octo-org/example-app', default_branch: 'main' } };
        return { status: 404 };
      },
    });
    expect(await GITHUB_OVERVIEW_TARGET_ACTIONS_V1[GITHUB_OVERVIEW_TARGET_ACTION_ID].run(
      { repository, ref: 'missing' }, transport.context,
    )).toEqual({ kind: 'unavailable', failure: { class: 'unknown', code: 'github_not_found' } });
    expect(transport.requests.map(request => request.url)).toEqual([
      'https://api.github.com/repos/octo-org/example-app',
      'https://api.github.com/repos/octo-org/example-app/commits/missing',
    ]);
  });

  it('resolves a qualified ref against the branch endpoint even when the name also resolves to a commit', async () => {
    const ref = 'refs/heads/release/current';
    const transport = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer test-only-placeholder' } },
      respond(request) {
        if (request.url === 'https://api.github.com/repos/octo-org/example-app') return { status: 200,
          body: { full_name: 'octo-org/example-app', default_branch: 'main' } };
        if (request.url.endsWith('/branches/release%2Fcurrent')) return { status: 200,
          body: { name: 'release/current', commit: { sha: headSha } } };
        return { status: 200, body: { sha: 'b'.repeat(40) } };
      },
    });
    await expect(GITHUB_OVERVIEW_TARGET_ACTIONS_V1[GITHUB_OVERVIEW_TARGET_ACTION_ID].run(
      { repository, ref }, transport.context,
    )).resolves.toEqual({ kind: 'value', value: { repository, branch: ref, headSha } });
  });

  it.each([
    { full_name: 'octo-org/other', default_branch: 'main' },
    { full_name: 'octo-org/example-app' },
  ])('refuses unavailable default-branch provenance without guessing HEAD: %j', async body => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 200, body }) });
    const client = await createTestGithubApiClient(transport);
    await expect(readGithubOverviewTargetV1(client, repository)).rejects.toThrow();
    expect(transport.requests).toHaveLength(1);
  });
});
