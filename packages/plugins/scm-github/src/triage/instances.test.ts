import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { TriageListInstancesResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { MAX_TRIAGE_INSTANCE_DRAFTS_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';

import {
  GITHUB_AUTHENTICATED_USER_RESPONSE,
  GITHUB_SECOND_AUTHENTICATED_USER_RESPONSE,
} from './__fixtures__/githubResponses.js';
import { decodeGithubTriageConfiguration } from './configuration.js';
import { listGithubTriageInstances } from './instances.js';
import { listGithubTriageInstancesOperation } from './operations.js';
import {
  createStubGithubTransport,
  fixedClock,
  type StubConnectedAccountListing,
} from './testkit/githubTriage.test-support.js';

const FIRST_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'account-one',
});
const SECOND_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'account-two',
});

function listing(
  status: 'complete' | 'truncated',
  accounts: readonly ConnectedAccountRef[],
): StubConnectedAccountListing {
  return Object.freeze({
    status,
    accounts: Object.freeze(accounts.map((account, index) => Object.freeze({
      account,
      displayName: `GitHub ${index + 1}`,
      state: 'connected' as const,
      connectedAccountOrigins: Object.freeze(['https://api.github.com']),
      connectedAccountBases: Object.freeze(['https://api.github.com']),
    }))),
  });
}

function transport(input: Readonly<{
  listing?: StubConnectedAccountListing | (() => never);
  binding?: Readonly<{ purpose: string }> | null;
  userStatus?: number;
  userHeaders?: Readonly<Record<string, string>>;
}>) {
  let identityReads = 0;
  return createStubGithubTransport({
    ...(input.listing === undefined ? {} : { listing: input.listing }),
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    respond: (request) => {
      if (!request.url.endsWith('/user')) return undefined;
      identityReads += 1;
      return {
        status: input.userStatus ?? 200,
        headers: { 'content-type': 'application/json', ...(input.userHeaders ?? {}) },
        body: identityReads === 1
          ? GITHUB_AUTHENTICATED_USER_RESPONSE
          : GITHUB_SECOND_AUTHENTICATED_USER_RESPONSE,
      };
    },
  });
}

describe('GitHub Triage discovery', () => {
  it('projects two purpose-scoped account metadata rows into two candidates with their exact binding refs', async () => {
    const stub = transport({ listing: listing('complete', [FIRST_ACCOUNT, SECOND_ACCOUNT]) });

    const result = await listGithubTriageInstances(stub.context, { now: fixedClock(1_000) });

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error('unreachable');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.binding)).toEqual([
      { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: FIRST_ACCOUNT },
      { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: SECOND_ACCOUNT },
    ]);
    expect(result.candidates.map((candidate) => candidate.locator.displayLabel))
      .toEqual(['octocat-dev', 'octocat-ops']);
    // The listing is asked for this source's own declared purpose and nothing else.
    expect(stub.listRequests).toEqual([
      { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, limit: MAX_TRIAGE_INSTANCE_DRAFTS_V1 },
    ]);
    // Each candidate reauthorized its OWN exact account rather than a bound default.
    expect(stub.materializations.map((entry) => entry.account))
      .toEqual([FIRST_ACCOUNT, SECOND_ACCOUNT]);
    expect(stub.materializations.every((entry) => (
      entry.purpose === GITHUB_CONNECTED_ACCOUNT_PURPOSE
    ))).toBe(true);
  });

  it('keeps localInstanceKey source-native while two account refs remain distinct candidates', async () => {
    const stub = transport({ listing: listing('complete', [FIRST_ACCOUNT, SECOND_ACCOUNT]) });

    const result = await listGithubTriageInstances(stub.context, { now: fixedClock(1_000) });
    if (result.kind !== 'complete') throw new Error('expected a complete discovery result');

    const keys = result.candidates.map((candidate) => candidate.localInstanceKey);
    expect(keys).toEqual(['github.com', 'github.com']);
    for (const candidate of result.candidates) {
      expect(candidate.localInstanceKey).not.toContain(candidate.binding.account.accountId);
      expect(candidate.localInstanceKey).not.toContain(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
      // A candidate is a Settings choice; it mints no configured-instance identity.
      expect(JSON.stringify(candidate)).not.toContain('sourceInstanceId');
      const decoded = decodeGithubTriageConfiguration(candidate.configuration.token);
      expect(decoded.ok && decoded.configuration.scope.kind).toBe('account');
      expect(candidate.configuration.token).not.toContain(candidate.binding.account.accountId);
    }
  });

  it('maps truncation to incomplete, a listing failure to failed, and never to complete', async () => {
    const truncated = transport({ listing: listing('truncated', [FIRST_ACCOUNT]) });
    const truncatedResult = await listGithubTriageInstances(truncated.context, {
      now: fixedClock(1_000),
    });
    expect(() => TriageListInstancesResultV1Schema.parse(truncatedResult)).not.toThrow();
    expect(truncatedResult.kind).toBe('incomplete');
    if (truncatedResult.kind !== 'incomplete') throw new Error('unreachable');
    expect(truncatedResult.candidates).toHaveLength(1);

    const failing = transport({
      listing: () => {
        throw new Error('connected account listing unavailable');
      },
    });
    const failedResult = await listGithubTriageInstances(failing.context, {
      now: fixedClock(1_000),
    });
    expect(() => TriageListInstancesResultV1Schema.parse(failedResult)).not.toThrow();
    expect(failedResult).toEqual({
      kind: 'failed',
      failure: { class: 'transient', code: 'github_request_failed' },
    });
    // A source that learned nothing performs no provider read on a missing listing.
    expect(failing.requests).toHaveLength(0);
  });

  /**
   * A reader with no connected GitHub account has configured nothing — they have
   * not been refused by GitHub. The host declines to list a purpose it holds no
   * selection for, and reporting that decline as a source failure tells the
   * Settings page that a provider it never contacted returned something
   * unreadable, hiding the one thing the reader can act on.
   */
  it('reports an unbound purpose as a complete empty candidate set, not a source failure', async () => {
    const unbound = transport({
      binding: null,
      listing: () => {
        throw Object.assign(new Error('resource not selected'), {
          code: 'plugin_host_access_resource_not_selected',
        });
      },
    });

    const result = await listGithubTriageInstances(unbound.context, { now: fixedClock(1_000) });

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(result).toEqual({ kind: 'complete', candidates: [], failures: [] });
    // The claim is the host's own answer about the binding, never an error-code guess.
    expect(unbound.bindingReads).toEqual([GITHUB_CONNECTED_ACCOUNT_PURPOSE]);
    // Nothing was connected, so no provider read was attempted.
    expect(unbound.requests).toHaveLength(0);
  });

  it('still reports a refused listing as a failure while the purpose is bound', async () => {
    const bound = transport({
      listing: () => {
        throw new Error('connected account listing unavailable');
      },
    });

    const result = await listGithubTriageInstances(bound.context, { now: fixedClock(1_000) });

    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'transient', code: 'github_request_failed' },
    });
    expect(bound.bindingReads).toEqual([GITHUB_CONNECTED_ACCOUNT_PURPOSE]);
  });

  it('reports one unauthorized account as an exact-binding failure without dropping the account', async () => {
    const stub = transport({ listing: listing('complete', [FIRST_ACCOUNT]), userStatus: 401 });

    const result = await listGithubTriageInstances(stub.context, { now: fixedClock(1_000) });

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(result).toEqual({
      kind: 'complete',
      candidates: [],
      failures: [{
        binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: FIRST_ACCOUNT },
        failure: { class: 'authentication', code: 'github_unauthorized' },
      }],
    });
  });

  it('refuses a listInstances input that carries anything beyond its version', async () => {
    const stub = transport({ listing: listing('complete', [FIRST_ACCOUNT]) });

    const result = await listGithubTriageInstancesOperation(
      { v: 1, binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: FIRST_ACCOUNT } },
      stub.context,
      { now: fixedClock(1_000) },
    );

    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'github_operation_input_invalid' },
    });
    expect(stub.listRequests).toHaveLength(0);
  });
});
