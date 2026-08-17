import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  TriageGetResultV1Schema,
  TriageScanResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

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
import { getGithubTriageEntry, scanGithubTriageSource } from './operations.js';
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
