import {
  TriageListInstancesResultV1Schema,
  type TriageListInstancesResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { decodeGitlabConfiguration } from './configuration.js';
import { GITLAB_CONNECTED_ACCOUNT_PURPOSE } from './contribution.js';
import type { GitlabConnectedAccounts } from './http/gitlabClient.js';
import { listGitlabTriageInstances } from './sourceInstances.js';

const SERVICE = Object.freeze({
  pluginId: 'happier.scm.forge.gitlab',
  localId: 'gitlab-account',
});

function account(accountId: string, origins: readonly string[], overrides: Readonly<{
  state?: 'connected' | 'expired' | 'reconnectRequired' | 'unavailable';
  displayName?: string;
}> = {}) {
  return {
    account: { service: SERVICE, accountId },
    displayName: overrides.displayName ?? `@user-${accountId}`,
    state: overrides.state ?? ('connected' as const),
    connectedAccountOrigins: origins,
  };
}

function connectedAccounts(listing: Readonly<{
  status: 'complete' | 'truncated';
  accounts: readonly ReturnType<typeof account>[];
}>) {
  const listAccounts = vi.fn(async () => listing);
  const materializeListedAccount = vi.fn(async () => {
    throw new Error('listInstances must not materialize a credential');
  });
  return {
    connectedAccounts: { listAccounts, materializeListedAccount } as unknown as
      GitlabConnectedAccounts,
    listAccounts,
    materializeListedAccount,
  };
}

async function list(listing: Parameters<typeof connectedAccounts>[0]) {
  const seam = connectedAccounts(listing);
  const result = await listGitlabTriageInstances({
    connectedAccounts: seam.connectedAccounts,
    signal: new AbortController().signal,
  });
  // Every emitted result is proven against the published union, so a shape this
  // source cannot actually publish fails here rather than at the aggregate.
  return {
    result: TriageListInstancesResultV1Schema.parse(result) as TriageListInstancesResultV1,
    seam,
  };
}

describe('GitLab listInstances', () => {
  it('projects two purpose-scoped account rows into two candidates with their exact binding refs', async () => {
    const { result, seam } = await list({
      status: 'complete',
      accounts: [
        account('account-1', ['https://gitlab.com']),
        account('account-2', ['https://gitlab.com']),
      ],
    });

    expect(seam.listAccounts).toHaveBeenCalledWith(
      { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE },
      { signal: expect.anything() },
    );
    if (result.kind !== 'complete') throw new Error(`expected complete, got ${result.kind}`);
    expect(result.candidates.map((candidate) => candidate.binding)).toEqual([
      { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: { service: SERVICE, accountId: 'account-1' } },
      { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: { service: SERVICE, accountId: 'account-2' } },
    ]);
  });

  it('keeps localInstanceKey source-native while two account refs remain distinct candidates', async () => {
    const { result } = await list({
      status: 'complete',
      accounts: [
        account('account-1', ['https://gitlab.com']),
        account('account-2', ['https://gitlab.com']),
      ],
    });

    if (result.kind !== 'complete') throw new Error(`expected complete, got ${result.kind}`);
    expect(result.candidates).toHaveLength(2);
    // One deployment, two accounts: the exact binding is a separate member of
    // the target's matching tuple, so the local key must not re-encode it.
    expect(result.candidates.map((candidate) => candidate.localInstanceKey))
      .toEqual(['https://gitlab.com', 'https://gitlab.com']);
    expect(result.candidates.every((candidate) => candidate.keyStability === 'locatorDerived'))
      .toBe(true);
    for (const candidate of result.candidates) {
      expect(candidate.localInstanceKey).not.toContain('account-');
      expect(candidate.localInstanceKey).not.toContain(GITLAB_CONNECTED_ACCOUNT_PURPOSE);
      // The source-private configuration is this source's own strict envelope
      // and never duplicates the configured origin.
      expect(decodeGitlabConfiguration(candidate.configuration)).toEqual({ v: 1 });
      expect(candidate.configuration.token).not.toContain('gitlab.com');
      expect(candidate.configuration.token).not.toContain('account-');
    }
  });

  it('carries every discovered account candidate instead of imposing a local thirty-two-instance ceiling', async () => {
    const { result } = await list({
      status: 'complete',
      accounts: Array.from({ length: 33 }, (_unused, index) => (
        account(`account-${index + 1}`, ['https://gitlab.com'])
      )),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error(`expected complete, got ${result.kind}`);
    expect(result.candidates).toHaveLength(33);
  });

  it('maps truncation to incomplete and a listing failure to failed, never complete', async () => {
    const truncated = await list({
      status: 'truncated',
      accounts: [account('account-1', ['https://gitlab.com'])],
    });
    if (truncated.result.kind !== 'incomplete') {
      throw new Error(`expected incomplete, got ${truncated.result.kind}`);
    }
    expect(truncated.result.candidates).toHaveLength(1);
    expect(truncated.result.failure?.code).toBe('account-listing-truncated');

    const listAccounts = vi.fn(async () => {
      throw new Error('connected accounts unavailable');
    });
    const failed = await listGitlabTriageInstances({
      connectedAccounts: { listAccounts, materializeListedAccount: vi.fn() } as unknown as
        GitlabConnectedAccounts,
      signal: new AbortController().signal,
    });
    expect(failed).toEqual({
      kind: 'failed',
      failure: {
        class: 'unknown',
        code: 'account-listing-failed',
        detail: expect.any(String),
      },
    });
  });

  it('rejects every non-GitLab.com origin as self-managed-floor-unset before an item call', async () => {
    const { result, seam } = await list({
      status: 'complete',
      accounts: [
        account('account-1', ['https://gitlab.example.test']),
        account('account-2', ['https://gitlab.com']),
      ],
    });

    if (result.kind !== 'complete') throw new Error(`expected complete, got ${result.kind}`);
    expect(result.candidates.map((candidate) => candidate.binding.account.accountId))
      .toEqual(['account-2']);
    expect(result.failures).toEqual([{
      binding: {
        purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
        account: { service: SERVICE, accountId: 'account-1' },
      },
      localInstanceKey: 'https://gitlab.example.test',
      failure: {
        class: 'unsupportedContract',
        code: 'self-managed-floor-unset',
        detail: expect.any(String),
      },
    }]);
    // No provider read of any kind runs for a rejected deployment: not a
    // version probe, not an edition inference, not one item call.
    expect(seam.materializeListedAccount).not.toHaveBeenCalled();
  });

  it('attributes an unusable account and an origin-less account without inventing a deployment', async () => {
    const { result } = await list({
      status: 'complete',
      accounts: [
        account('account-1', ['https://gitlab.com'], { state: 'reconnectRequired' }),
        account('account-2', []),
      ],
    });

    if (result.kind !== 'complete') throw new Error(`expected complete, got ${result.kind}`);
    expect(result.candidates).toEqual([]);
    expect(result.failures.map(({ failure }) => failure.code))
      .toEqual(['account-not-connected', 'configured-origin-unavailable']);
    // Defaulting an origin-less account to gitlab.com is how a credential
    // reaches a deployment its owner never named.
    expect(result.failures[1]).not.toHaveProperty('localInstanceKey');
  });
});

/**
 * The host declines to list a purpose it holds no selection for. Reporting that
 * decline as `account-listing-failed` tells a reader who has connected nothing
 * that GitLab could not be read, when GitLab was never asked.
 */
describe('GitLab listInstances with no connected account', () => {
  function refusedListing(binding: unknown) {
    const listAccounts = vi.fn(async () => {
      throw Object.assign(new Error('resource not selected'), {
        code: 'plugin_host_access_resource_not_selected',
      });
    });
    const getBinding = vi.fn(async () => binding);
    return {
      seam: { listAccounts, getBinding } as unknown as GitlabConnectedAccounts,
      listAccounts,
      getBinding,
    };
  }

  it('reports an unbound purpose as a complete empty candidate set', async () => {
    const stub = refusedListing(null);

    const result = await listGitlabTriageInstances({
      connectedAccounts: stub.seam,
      signal: new AbortController().signal,
    });

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(result).toEqual({ kind: 'complete', candidates: [], failures: [] });
    expect(stub.getBinding).toHaveBeenCalledWith(
      GITLAB_CONNECTED_ACCOUNT_PURPOSE,
      { signal: expect.anything() },
    );
  });

  it('still fails a refused listing while the purpose is bound', async () => {
    const stub = refusedListing({ purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE });

    const result = await listGitlabTriageInstances({
      connectedAccounts: stub.seam,
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.failure.code).toBe('account-listing-failed');
  });
});
