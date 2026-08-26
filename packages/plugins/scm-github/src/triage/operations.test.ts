import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  TriageGetResultV1Schema,
  TriagePrepareReviewWorkspaceResultV1Schema,
  TriageScanResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it, vi } from 'vitest';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../observations/githubProviderContracts.js';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
  githubSearchResponse,
} from './__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import {
  getGithubTriageEntry,
  prepareGithubTriageReviewWorkspace,
  scanGithubTriageSource,
} from './operations.js';
import {
  createStubGithubTransport,
  fixedClock,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
const CONFIGURED_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'configured-account',
});
const OTHER_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'other-account',
});

const GITHUB_FORK_PULL_REQUEST_RESPONSE = Object.freeze({
  ...GITHUB_PULL_REQUEST_RESPONSE,
  head: Object.freeze({
    label: 'fork-user:review-from-fork',
    ref: 'review-from-fork',
    sha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    repo: Object.freeze({
      id: 8128,
      owner: Object.freeze({ login: 'fork-user' }),
      name: 'fork-app',
      full_name: 'fork-user/fork-app',
      clone_url: 'https://github.com/fork-user/fork-app.git',
    }),
  }),
  base: Object.freeze({
    ...(GITHUB_PULL_REQUEST_RESPONSE.base as Readonly<Record<string, unknown>>),
    repo: Object.freeze({
      id: Number(GITHUB_FIXTURE_REPOSITORY_ID),
      owner: Object.freeze({ login: GITHUB_FIXTURE_OWNER }),
      name: GITHUB_FIXTURE_REPOSITORY,
      full_name: `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`,
      clone_url: `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}.git`,
    }),
  }),
});

function prepareWorkspaceInput(input: Readonly<{
  scope?: 'repository' | 'account';
  observed?: Partial<Readonly<{
    baseSha: string;
    headSha: string;
    nativeRevision: string;
  }>>;
  workspace?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
}>) {
  return {
    v: 1 as const,
    // Account-wide discovery owns no repository configuration. Its newest
    // source locator is the only route preparation may use for this entry.
    instance: configuredInstance({ scope: input.scope ?? 'account' }),
    entryRef: {
      source: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }),
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    },
    lastKnownLocator: { v: 1 as const, routingToken: REPOSITORY_KEY },
    observed: {
      baseSha: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e',
      headSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      nativeRevision: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      observedAtMs: 1_700_000_000_000,
      ...input.observed,
    },
    workspace: input.workspace === undefined
      ? { serverId: 'server-selected', machineId: 'machine-selected', rootPath: '/selected/repository' }
      : input.workspace,
  };
}

function withReviewWorkspaceMaterializer(
  context: PluginInvocationContext,
  result: unknown = Object.freeze({
    success: true as const,
    targetPath: '/selected/repository/.happier/review/review-from-fork',
    branchName: 'review-from-fork',
    created: true,
    currentness: Object.freeze({ kind: 'currentAtObservedHead' as const }),
  }),
): Readonly<{
  context: PluginInvocationContext;
  execute: ReturnType<typeof vi.fn>;
}> {
  // The generic SCM Action is a process boundary. The GitHub source operation,
  // its exact-account reauthorization and its provider reread remain real.
  const execute = vi.fn(async () => result);
  return Object.freeze({
    execute,
    context: {
      ...context,
      services: { ...context.services, actions: { execute } },
    } as unknown as PluginInvocationContext,
  });
}

function configuredInstance(input: Readonly<{
  scope: 'repository' | 'account';
  purpose?: string;
  account?: ConnectedAccountRef;
}>): TriageConfiguredSourceInstanceV1 {
  const token = encodeGithubTriageConfiguration(
    input.scope === 'repository'
      ? { v: 1, scope: { kind: 'repository', repositoryKey: REPOSITORY_KEY } }
      : { v: 1, scope: { kind: 'account' } },
  );
  if (token === null) throw new Error('the fixture configuration must encode');
  const fixture = createTriageSourceV1Fixture();
  return Object.freeze({
    ...fixture.configuredInstance,
    instance: Object.freeze({
      source: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }),
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
    }),
    binding: Object.freeze({
      purpose: input.purpose ?? GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: input.account ?? CONFIGURED_ACCOUNT,
    }),
    localInstanceKey: 'github.com',
    configuration: Object.freeze({ v: 1 as const, token }),
  });
}

function searchTransport() {
  return createStubGithubTransport({
    respond: (request): StubHttpResponse | undefined => {
      if (!request.url.startsWith('https://api.github.com/search/issues')) return undefined;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }),
      };
    },
  });
}

describe('GitHub Triage source operations', () => {
  it('projects a GitHub scan onto the strict source ABI as one settled result with no continuation', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      page: { kind: 'initial', limit: 64 },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
    // One whole native page spends the ABI-capped budget, so this call settles the
    // PAGE arm with the source's own continuation and the rotation resumes at the
    // second involvement lane — every lane is reached inside the one refresh.
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') throw new Error('unreachable');
    expect(result.continuation.v).toBe(1);
    expect(typeof result.continuation.token).toBe('string');
    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0];
    if (observation?.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.localRef).toEqual({
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    });
    expect(observation.locator.routingToken).toBe(REPOSITORY_KEY);
    expect(observation.viewer.involvement).toEqual(['reviewRequested']);
    // The public row-fact arms name their payload `value`; the plugin's own arms do
    // not, and this projection is the only place that rename happens.
    const numberFact = observation.snapshot.facts.find((fact) => fact.id === 'github/number');
    expect(numberFact?.value).toEqual({ kind: 'text', value: '#1284' });
    // `projection-budget` describes this PAGE's shape — it is not a claim that the
    // walk stopped early, because the continuation carries it forward.
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'projection-budget' });
    expect(stub.requests).toHaveLength(1);
  });

  it('materializes only the exact configured account and never a caller-supplied one', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository', account: OTHER_ACCOUNT }),
      page: { kind: 'initial', limit: 64 },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(stub.materializations).toEqual([{
      purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: OTHER_ACCOUNT,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
    }]);
    // The credential belongs on the outbound request and NOWHERE else: it never
    // reaches the source result, and the result carries no account ref either.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-only-placeholder');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain(OTHER_ACCOUNT.accountId);
  });

  it('reauthorizes a GitHub fork source tip before materializing only at the selected workspace root', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const materializer = withReviewWorkspaceMaterializer(stub.context);

    const result = await prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({}),
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    );

    expect(() => TriagePrepareReviewWorkspaceResultV1Schema.parse(result)).not.toThrow();
    expect(result).toEqual({
      kind: 'prepared',
      repositoryPath: '/selected/repository/.happier/review/review-from-fork',
      branch: 'review-from-fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' },
      // The source transports a bounded reference after the canonical reread;
      // the generic SCM/Reviews producer remains its only grammar validator.
      pullRequest: { number: 1284 },
    });
    // The source's exact configured account is still the sole credential that
    // reaches GitHub. The generic materializer receives no account authority.
    expect(stub.materializations).toEqual([{
      purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: CONFIGURED_ACCOUNT,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
    }]);
    // The source repo is a fork. Base/target facts remain the route/read
    // authority and must never become the editable checkout target.
    expect(materializer.execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: '/selected/repository',
        displayName: 'review-from-fork',
        sourceTip: {
          repository: {
            kind: 'github',
            deployment: 'https://github.com',
            repository: 'fork-user/fork-app',
          },
          cloneUrl: 'https://github.com/fork-user/fork-app.git',
          branch: 'review-from-fork',
          sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
          fetchRef: 'refs/heads/review-from-fork',
        },
      },
      { signal: materializer.context.signal },
    );
  });

  it('requires an already-selected workspace without reading GitHub or probing local SCM', async () => {
    const stub = searchTransport();
    const materializer = withReviewWorkspaceMaterializer(stub.context);

    await expect(prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({ workspace: null }),
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual({ kind: 'workspaceRequired' });

    expect(stub.materializations).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);
    expect(materializer.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['baseSha', '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2f'],
    ['headSha', '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e20'],
    ['nativeRevision', '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e20'],
  ] as const)('refuses a reread whose observed %s moved before local materialization', async (field, value) => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const materializer = withReviewWorkspaceMaterializer(stub.context);

    const result = await prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({ observed: { [field]: value } }),
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    );

    expect(result).toEqual({ kind: 'refused', reason: 'observedHeadMoved' });
    expect(materializer.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_REPOSITORY', { kind: 'workspaceMismatch' }],
    ['INVALID_PATH', { kind: 'workspaceMismatch' }],
    ['REMOTE_NOT_FOUND', { kind: 'workspaceMismatch' }],
    ['COMMAND_FAILED', { kind: 'unavailable', reason: 'scmResolver' }],
  ] as const)('projects generic local materialization %s without granting a fallback path', async (
    errorCode,
    expected,
  ) => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const materializer = withReviewWorkspaceMaterializer(stub.context, Object.freeze({
      success: false as const,
      error: 'synthetic local materialization failure',
      errorCode,
    }));

    await expect(prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({}),
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual(expected);
    expect(materializer.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a continuation this process did not mint rather than guessing a frontier', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      page: { kind: 'continuation', continuation: { v: 1, token: 'lane-frontier' } },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    // The continuation is refresh-local. A token from another process, another
    // version, or another configured instance restarts the walk at `initial`; it is
    // never a resume point this source will honour.
    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'github_scan_continuation_unrecognized' },
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('walks every involvement lane to exhaustion across continuation pages inside one refresh', async () => {
    const stub = searchTransport();
    const instance = configuredInstance({ scope: 'repository' });
    const lanes: string[] = [];
    let request: Parameters<typeof scanGithubTriageSource>[0] = {
      v: 1,
      instance,
      page: { kind: 'initial', limit: 64 },
    };

    for (let page = 0; page < 8; page += 1) {
      const result = await scanGithubTriageSource(
        request,
        stub.context,
        { now: fixedClock(1_700_000_000_000) },
      );
      expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
      lanes.push(new URL(stub.requests.at(-1)?.url ?? '').searchParams.get('q') ?? '');
      if (result.kind === 'complete') break;
      if (result.kind !== 'page') throw new Error('expected a page arm');
      request = { v: 1, instance, page: { kind: 'continuation', continuation: result.continuation } };
    }

    // Without the continuation the first lane consumed the whole budget on every
    // refresh and `assigned`, `mentioned`, `reviewed` and `authored` were never read.
    expect(lanes.map((query) => query.split(' ').at(-1))).toEqual([
      'review-requested:@me',
      'assignee:@me',
      'mentions:@me',
      'reviewed-by:@me',
      'author:@me',
    ]);
  });

  it('refuses a configured instance bound to another declared purpose', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository', purpose: 'gitlab-connected-account' }),
      page: { kind: 'initial', limit: 64 },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'github_instance_binding_foreign' },
    });
    expect(stub.materializations).toHaveLength(0);
  });

  it('returns the exact input local ref from an authoritative get', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      localRef,
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
    expect(result.kind).toBe('present');
    expect(result.localRef).toEqual(localRef);
    if (result.kind !== 'present') throw new Error('expected present GitHub pull request');
    expect(result.snapshot.reviewRevision).toEqual({
      baseSha: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e',
      headSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      nativeRevision: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    });
  });

  it('answers unresolved without an outbound call when the configured instance carries no route', async () => {
    const stub = searchTransport();
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'account' }),
      localRef,
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    // An account-scoped instance names no repository and the target has never
    // observed this entry, so there is no route. The answer is the contract's
    // `unresolved`, and no path is guessed from identity or display text.
    expect(result).toEqual({
      kind: 'unresolved',
      localRef,
      failure: { class: 'unknown', code: 'github_locator_unusable' },
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('routes an account-wide get through the last-known locator the target observed', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      // Account-wide: the configured instance names no repository at all.
      instance: configuredInstance({ scope: 'account' }),
      localRef,
      lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    // An account-wide scan discovers entries across many repositories, so the
    // locator is the only evidence that can name this entry's one. It grants no
    // authority: the response is still validated against the requested ref.
    expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
    expect(result.kind).toBe('present');
    expect(result.localRef).toEqual(localRef);
    expect(stub.requests).toHaveLength(1);
  });

  it('answers unresolved without an outbound call when the last-known locator carries no usable route', async () => {
    const stub = searchTransport();
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'account' }),
      localRef,
      // Display facts are never API-route fallbacks, and an origin-bearing token is
      // not a route this source minted.
      lastKnownLocator: {
        v: 1,
        displayPath: `${REPOSITORY_KEY}#1284`,
        webUrl: `https://github.com/${REPOSITORY_KEY}/pull/1284`,
      },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(result).toEqual({
      kind: 'unresolved',
      localRef,
      failure: { class: 'unknown', code: 'github_locator_unusable' },
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses an undeclared kind rather than reading a route for it', async () => {
    const stub = searchTransport();

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      localRef: {
        kindId: 'merge-request',
        collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
        entryId: '1284',
      },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(result).toEqual({
      kind: 'unresolved',
      localRef: {
        kindId: 'merge-request',
        collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
        entryId: '1284',
      },
      failure: { class: 'unsupportedContract', code: 'github_kind_undeclared' },
    });
    expect(stub.requests).toHaveLength(0);
  });
});
