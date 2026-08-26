import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
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
  binding?: unknown;
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
  // The host answers the same authorized-target read two ways: `listAccounts` throws
  // for a purpose it holds no selection for, and `getBinding` answers `null` there.
  const getBinding = vi.fn(async () => options.binding ?? null);
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
        connectedAccounts: { listAccounts, materializeListedAccount, getBinding },
        http: { request },
      },
    } as unknown as PluginInvocationContext,
    listAccounts,
    materializeListedAccount,
    getBinding,
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
  it('reports a first run with no selected account as an empty listing, not a Sentry failure', async () => {
    // The host declines to list a purpose it holds no selection for, and that refusal
    // is a throw. Mapping it into this source's provider vocabulary would accuse a
    // Sentry deployment no request was ever sent to, and hide the one thing the
    // reader can act on.
    const harness = host();
    harness.listAccounts.mockRejectedValue(new Error('purpose has no selected account'));

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(result).toEqual({ kind: 'complete', candidates: [], failures: [] });
    expect(harness.getBinding).toHaveBeenCalledWith(
      SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      { signal: harness.context.signal },
    );
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('lets a listing refusal that is not an unbound purpose keep propagating', async () => {
    // A source that learned nothing must not claim it learned that there is nothing:
    // a confirmed binding means the listing failed for some other reason.
    const harness = host({ binding: { account: ACCOUNT } });
    const refusal = new Error('connected accounts unavailable');
    harness.listAccounts.mockRejectedValue(refusal);

    await expect(listSentryInstances({ v: 1 }, harness.context)).rejects.toBe(refusal);
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('discovers candidates through the exact listed account, on the origin the host projected', async () => {
    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [onOrigin(organizationsCloudPage, 'https://de.sentry.io')],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(harness.listAccounts).toHaveBeenCalledWith(
      { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE },
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

  it('carries every discovered organization instead of imposing a local thirty-two-instance ceiling', async () => {
    const recorded = onOrigin(organizationsCloudPage, 'https://de.sentry.io');
    const organization = (recorded.body as readonly Record<string, unknown>[])[0];
    if (organization === undefined) throw new Error('expected one recorded organization');
    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [{
        ...recorded,
        body: Array.from({ length: 33 }, (_unused, index) => ({
          ...organization,
          id: String(index + 1),
          slug: `organization-${index + 1}`,
          name: `Organization ${index + 1}`,
        })),
      }],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected complete discovery');
    expect(result.candidates).toHaveLength(33);
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

  it('keeps valid organization siblings but never reports a skipped malformed sibling as complete discovery', async () => {
    const recorded = onOrigin(organizationsCloudPage, 'https://de.sentry.io');
    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [{
        ...recorded,
        body: [
          ...(recorded.body as readonly unknown[]),
          { id: 'not-a-numeric-organization-id', name: 'Unreadable sibling' },
        ],
      }],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(result.kind).toBe('incomplete');
    if (result.kind !== 'incomplete') return;
    expect(result.candidates).toHaveLength(1);
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: SENTRY_FAILURE_CODES.malformedOrganizationRow,
    });
    expect(result.failures).toContainEqual({
      binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
      failure: {
        class: 'unsupportedContract',
        code: SENTRY_FAILURE_CODES.malformedOrganizationRow,
      },
    });
  });

  /**
   * Sentry's organization cursor is an OFFSET triple (`value:offset:is_prev`), so a
   * concurrent create, delete or rename shifts the window between two pages and hands
   * back an organization the walk already recorded. Each copy became its own candidate:
   * the same organization was offered twice in Settings, and each duplicate obscured a
   * DISTINCT organization in the discovery result.
   *
   * A candidate is identified by its match tuple, which the draft already carries: the
   * exact account binding plus `localInstanceKey`. Two rows resolving to that same tuple
   * are one candidate, not two.
   */
  it('records one candidate per organization when offset paging returns the same row twice', async () => {
    const page = (
      organizationIds: readonly string[],
      nextResults: boolean,
      cursor: string,
    ): RecordedResponse => ({
      status: 200,
      headers: {
        'content-type': 'application/json',
        link: `<https://de.sentry.io/api/0/organizations/?&cursor=${cursor}>; rel="next"; results="${String(nextResults)}"; cursor="${cursor}"`,
      },
      body: organizationIds.map((id) => ({
        id,
        slug: `org-${id}`,
        name: `Org ${id}`,
        links: { organizationUrl: `https://org-${id}.sentry.io`, regionUrl: 'https://de.sentry.io' },
      })),
    });

    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [
        page(['7701', '7702'], true, '1:0:0'),
        // The window shifted: `7702` is repeated, and `7703` is genuinely new.
        page(['7702', '7703'], false, '1:100:0'),
      ],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    if (result.kind === 'failed') return;
    // Every DISTINCT organization survives; only the repeat is dropped.
    expect(result.candidates.map((candidate) => candidate.localInstanceKey)).toEqual([
      `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`,
      `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7702`,
      `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7703`,
    ]);
    // A repeat is not a provider contract failure either: nothing is reported as broken.
    expect(result.failures).toEqual([]);
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
