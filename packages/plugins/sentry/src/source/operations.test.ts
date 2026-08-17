import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  MAX_TRIAGE_INSTANCE_DRAFTS_V1,
  TriageGetResultV1Schema,
  TriageListInstancesResultV1Schema,
  TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import issueDetail from '../fixtures/issueDetail.json' with { type: 'json' };
import issuesListPage1 from '../fixtures/issuesListPage1.json' with { type: 'json' };
import organizationsCloudPage from '../fixtures/organizationsCloudPage.json' with { type: 'json' };

import {
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_FAILURE_CODES,
  SENTRY_SCOPE_SEPARATOR,
} from '../sentryContracts.js';
import { encodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';

import {
  getSentrySourceEntry,
  listSentryInstances,
  scanSentrySource,
} from './operations.js';

const ACCOUNT = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.sentry', localId: 'sentry-account' }),
  accountId: 'account-1',
});

const ORGANIZATION_ID = '7701';

type RecordedResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>;

/**
 * Rewrites a recorded US Cloud capture onto another deployment origin. Only the
 * declared route changes; every provider field the parsers read is preserved.
 */
function onOrigin(recorded: RecordedResponse, origin: string): RecordedResponse {
  const rewritten = JSON.parse(
    JSON.stringify({ headers: recorded.headers, body: recorded.body })
      .split('https://us.sentry.io')
      .join(origin),
  ) as Readonly<{ headers: Readonly<Record<string, string>>; body: unknown }>;
  return { status: recorded.status, headers: rewritten.headers, body: rewritten.body };
}

function host(options: Readonly<{
  origins?: readonly string[];
  listStatus?: 'complete' | 'truncated';
  responses?: readonly RecordedResponse[];
}> = {}) {
  const responses = options.responses ?? [];
  let call = 0;
  const listAccounts = vi.fn(async () => ({
    status: options.listStatus ?? ('complete' as const),
    accounts: [{
      account: ACCOUNT,
      displayName: 'Sentry · de.sentry.io',
      state: 'connected' as const,
      connectedAccountOrigins: options.origins ?? ['https://de.sentry.io'],
      connectedAccountBases: options.origins ?? ['https://de.sentry.io'],
    }],
  }));
  const materializeListedAccount = vi.fn(async () => ({
    kind: 'httpHeaders' as const,
    headers: { authorization: 'Bearer test-token-value' },
  }));
  const request = vi.fn(async (input: Readonly<{ url: string }>) => {
    const recorded = responses[call++];
    if (recorded === undefined) throw new Error(`unexpected request ${input.url}`);
    return {
      status: recorded.status,
      finalUrl: input.url,
      headers: recorded.headers,
      body: new TextEncoder().encode(JSON.stringify(recorded.body)),
    };
  });
  return {
    context: {
      signal: new AbortController().signal,
      services: {
        connectedAccounts: { listAccounts, materializeListedAccount },
        http: { request },
      },
    } as unknown as PluginInvocationContext,
    listAccounts,
    materializeListedAccount,
    request,
  };
}

function configuredInstance(origin: string) {
  const token = encodeSentryInstanceConfiguration({
    v: 1,
    organizationId: ORGANIZATION_ID,
    projectScope: { kind: 'allAccessible' },
    environmentScope: { kind: 'all' },
  });
  return {
    v: 1 as const,
    instance: {
      source: { pluginId: 'happier.sentry', localId: 'sentry-issues' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
    localInstanceKey: `${origin}${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
    configuration: { v: 1 as const, token },
  };
}

describe('Sentry Triage source operations', () => {
  it('discovers candidates through the exact listed account, on the origin the host projected', async () => {
    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [onOrigin(organizationsCloudPage, 'https://de.sentry.io')],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(harness.listAccounts).toHaveBeenCalledWith(
      { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, limit: MAX_TRIAGE_INSTANCE_DRAFTS_V1 },
      { signal: harness.context.signal },
    );
    expect(harness.request.mock.calls[0]?.[0]?.url)
      .toBe('https://de.sentry.io/api/0/organizations/?per_page=100');
    expect(harness.materializeListedAccount).toHaveBeenCalledWith({
      purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      account: ACCOUNT,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://de.sentry.io',
        headerNames: ['authorization'],
      },
    }, { signal: harness.context.signal });
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
      localInstanceKey: `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
      keyStability: 'locatorDerived',
    });
  });

  it('discovers the US Cloud deployment when that is the projected origin', async () => {
    const harness = host({
      origins: ['https://us.sentry.io'],
      responses: [organizationsCloudPage],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(harness.request.mock.calls[0]?.[0]?.url)
      .toBe('https://us.sentry.io/api/0/organizations/?per_page=100');
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    expect(result.candidates[0]?.localInstanceKey)
      .toBe(`https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`);
  });

  it('never guesses a deployment for an account whose route the host did not project', async () => {
    const harness = host({ origins: [], responses: [] });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.materializeListedAccount).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'complete',
      candidates: [],
      failures: [{
        binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
        failure: {
          class: 'unsupportedContract',
          code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
        },
      }],
    });
  });

  it('reports a truncated account listing as incomplete discovery', async () => {
    const harness = host({
      listStatus: 'truncated',
      responses: [onOrigin(organizationsCloudPage, 'https://de.sentry.io')],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(result.kind).toBe('incomplete');
    if (result.kind !== 'incomplete') return;
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: SENTRY_FAILURE_CODES.accountListTruncated,
    });
    expect(result.candidates).toHaveLength(1);
  });

  it('scans the configured instance on its own origin and carries a continuation', async () => {
    const harness = host({
      responses: [onOrigin(issuesListPage1, 'https://de.sentry.io')],
    });

    const result = await scanSentrySource({
      v: 1,
      instance: configuredInstance('https://de.sentry.io'),
      page: { kind: 'initial', limit: 32 },
    }, harness.context);

    expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
    expect(harness.request.mock.calls[0]?.[0]?.url)
      .toContain('https://de.sentry.io/api/0/organizations/7701/issues/');
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations[0]).toMatchObject({
      kind: 'present',
      localRef: {
        kindId: 'error-issue',
        collisionScope: `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
      },
    });
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });

  it('reads one issue authoritatively and returns the exact requested local ref', async () => {
    const harness = host({ responses: [onOrigin(issueDetail, 'https://de.sentry.io')] });
    const collisionScope = `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`;

    const result = await getSentrySourceEntry({
      v: 1,
      instance: configuredInstance('https://de.sentry.io'),
      localRef: { kindId: 'error-issue', collisionScope, entryId: '5501001' },
    }, harness.context);

    expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
    expect(harness.request.mock.calls[0]?.[0]?.url)
      .toBe('https://de.sentry.io/api/0/organizations/7701/issues/5501001/');
    expect(result).toMatchObject({
      kind: 'present',
      localRef: { kindId: 'error-issue', collisionScope, entryId: '5501001' },
    });
  });

  it('refuses a local ref that belongs to another configured scope', async () => {
    const harness = host({ responses: [] });

    const result = await getSentrySourceEntry({
      v: 1,
      instance: configuredInstance('https://de.sentry.io'),
      localRef: {
        kindId: 'error-issue',
        collisionScope: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
        entryId: '5501001',
      },
    }, harness.context);

    expect(harness.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract' },
    });
  });
});
