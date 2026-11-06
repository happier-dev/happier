import { describe, expect, it } from 'vitest';
import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
} from '@happier-dev/protocol/connect/account-usage-primitives';
import { ProviderUsageSourceV1Schema } from '@happier-dev/protocol/providers/contributions';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { DaemonProviderUsageRefreshResponseV1Schema } from '@happier-dev/protocol/rpc';

import { presentProviderConnectionUsage } from './presentProviderConnectionUsage';
import type { ProviderConnectionUsageRefreshView } from './providerConnectionUsageRefreshResource';

const keySource = ProviderUsageSourceV1Schema.parse({
  id: 'key-usage',
  endpointTemplateId: 'chat',
  path: '/api/v1/key',
  parser: 'key',
});
const creditSource = ProviderUsageSourceV1Schema.parse({
  id: 'account-credits',
  endpointTemplateId: 'chat',
  path: '/api/v1/credits',
  parser: 'credits',
  billingCredential: {
    slotId: 'managementKey',
    title: 'Management key',
    keyUrl: 'https://example.com/keys',
    destination: {
      kind: 'httpHeader',
      name: 'authorization',
      format: 'bearer',
    },
  },
});
const recordKey = {
  providerId: 'provider',
  accountSubjectId: 'subject',
  subjectKind: 'unknown',
  quotaScope: 'provider',
} as const;
const usd = {
  unit: 'usd',
  utilizationPct: null,
  resetsAt: null,
  status: 'ok',
  source: 'provider_api',
  confidence: 'exact',
  details: {},
} as const;

// Meters exactly as the real Provider usage parsers shape them (key spend, nullable allowance, account balance).
function snapshot(
  meters: readonly Record<string, unknown>[],
  fetchedAtMs = 1_000,
) {
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'provider',
    accountSubject: { kind: 'provisionalLocalSubject', id: 'subject' },
    observedAtMs: fetchedAtMs,
    fetchedAtMs,
    staleAfterMs: 60_000,
    source: 'providerHttp',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters,
  });
}
const keyMeters = [
  { ...usd, meterId: 'spend-today', label: 'Today', used: 1.25, limit: null },
  {
    ...usd,
    meterId: 'allowance-uncapped',
    label: 'Allowance',
    used: null,
    limit: null,
    remaining: null,
  },
  {
    ...usd,
    meterId: 'allowance-capped',
    label: 'Capped allowance',
    used: 3,
    limit: 10,
    remaining: 7,
  },
];
const creditMeters = [
  {
    ...usd,
    meterId: 'account-credits',
    label: 'Credits',
    used: 12,
    limit: null,
    remaining: -2,
    limitScope: 'account',
  },
];

function view(
  response: unknown,
  snapshots: ProviderConnectionUsageRefreshView['snapshotsBySourceId'],
): ProviderConnectionUsageRefreshView {
  return {
    result: DaemonProviderUsageRefreshResponseV1Schema.parse(response),
    snapshotsBySourceId: snapshots,
    stateBySourceId: {},
  };
}

describe('Provider connection usage presentation', () => {
  it('carries explicit denomination without treating a non-USD balance as USD', () => {
    const credits = snapshot([{ ...usd, meterId: 'balance-CNY', label: 'Balance (CNY)',
      currency: 'CNY', unit: 'unknown', used: null, remaining: -0.0123, limit: null, limitScope: 'account' }]);
    const presentation = presentProviderConnectionUsage({ sources: [keySource], isBillingSlotBound: () => true,
      view: view({ status: 'success', sources: [{ sourceId: keySource.id, status: 'ok', snapshot: credits }] },
        { [keySource.id]: credits }) });
    expect(presentation.groups[0]?.meters[0]).toMatchObject({ currency: 'CNY', unit: 'unknown',
      amount: { kind: 'remaining', remaining: -0.0123 }, remainingPct: null, tone: 'danger' });
  });
  it('keeps every amount as reported: unknown is null, uncapped has no percentage, a negative balance stays negative', () => {
    const key = snapshot(keyMeters);
    const credits = snapshot(creditMeters, 2_000);
    const presentation = presentProviderConnectionUsage({
      sources: [keySource, creditSource],
      isBillingSlotBound: () => true,
      view: view(
        {
          status: 'success',
          sources: [
            { sourceId: 'key-usage', status: 'ok', snapshot: key },
            { sourceId: 'account-credits', status: 'ok', snapshot: credits },
          ],
        },
        { 'key-usage': key, 'account-credits': credits },
      ),
    });
    expect(presentation.groups.map((group) => group.scope)).toEqual([
      'key',
      'account',
    ]);
    const [keyGroup, accountGroup] = presentation.groups;
    expect(
      keyGroup!.meters.map((meter) => [
        meter.meterId,
        meter.amount,
        meter.remainingPct,
      ]),
    ).toEqual([
      ['spend-today', { kind: 'used', used: 1.25 }, null],
      ['allowance-uncapped', null, null],
      [
        'allowance-capped',
        { kind: 'remainingOfLimit', remaining: 7, limit: 10 },
        70,
      ],
    ]);
    expect(accountGroup!.meters).toEqual([
      expect.objectContaining({
        meterId: 'account-credits',
        amount: { kind: 'remaining', remaining: -2 },
        remainingPct: null,
        tone: 'danger',
      }),
    ]);
    expect(presentation.fetchedAt).toBe(1_000);
    expect(presentation.billingSlots).toEqual([
      {
        slotId: 'managementKey',
        title: 'Management key',
        keyUrl: 'https://example.com/keys',
        bound: true,
      },
    ]);
  });

  it('shows no account-credit figures or failures while the billing key is unbound, even from an earlier view', () => {
    const key = snapshot(keyMeters);
    const credits = snapshot(creditMeters, 500);
    const presentation = presentProviderConnectionUsage({
      sources: [keySource, creditSource],
      isBillingSlotBound: () => false,
      view: view(
        {
          status: 'success',
          sources: [
            { sourceId: 'key-usage', status: 'ok', snapshot: key },
            {
              sourceId: 'account-credits',
              status: 'error',
              error: createProviderErrorV1(
                'provider_endpoint_unauthorized',
                {},
              ),
            },
          ],
        },
        { 'key-usage': key, 'account-credits': credits },
      ),
    });
    expect(presentation.groups.map((group) => group.scope)).toEqual(['key']);
    expect(presentation.sourceErrors).toEqual([]);
    expect(presentation.billingSlots[0]?.bound).toBe(false);
    expect(presentation.fetchedAt).toBe(1_000);
  });

  it('dates a partial refresh by the retained balance rather than newer key usage or an empty source', () => {
    const key = snapshot(keyMeters, 2_000);
    const credits = snapshot(creditMeters, 1_000);
    const emptySource = { ...keySource, id: 'empty-source' };
    const empty = snapshot([], 500);
    const presentation = presentProviderConnectionUsage({
      sources: [keySource, creditSource, emptySource],
      isBillingSlotBound: () => true,
      view: view({
        status: 'success',
        sources: [
          { sourceId: keySource.id, status: 'ok', snapshot: key },
          { sourceId: creditSource.id, status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable') },
          { sourceId: emptySource.id, status: 'ok', snapshot: empty },
        ],
      }, { [keySource.id]: key, [creditSource.id]: credits, [emptySource.id]: empty }),
    });
    expect(presentation.groups.find(group => group.scope === 'account')?.meters[0]?.amount)
      .toEqual({ kind: 'remaining', remaining: -2 });
    expect(presentation.sourceErrors[0]).toMatchObject({ sourceId: creditSource.id, lastGood: true });
    expect(presentation.fetchedAt).toBe(1_000);

    const onlyEmpty = presentProviderConnectionUsage({
      sources: [emptySource], isBillingSlotBound: () => true,
      view: view({ status: 'success', sources: [{ sourceId: emptySource.id, status: 'ok', snapshot: empty }] },
        { [emptySource.id]: empty }),
    });
    expect(onlyEmpty.groups).toEqual([]);
    expect(onlyEmpty.fetchedAt).toBeNull();
  });

  it('reports a failed source beside its last good figures, and distinguishes never checked from unsupported', () => {
    const key = snapshot(keyMeters);
    const failed = presentProviderConnectionUsage({
      sources: [keySource],
      isBillingSlotBound: () => true,
      view: view(
        {
          status: 'success',
          sources: [
            {
              sourceId: 'key-usage',
              status: 'error',
              error: createProviderErrorV1(
                'provider_endpoint_rate_limited',
                {},
              ),
            },
          ],
        },
        { 'key-usage': key },
      ),
    });
    expect(failed.sourceErrors).toEqual([
      expect.objectContaining({
        sourceId: 'key-usage',
        scope: 'key',
        billingSlotId: null,
        lastGood: true,
      }),
    ]);
    expect(failed.groups[0]?.meters).toHaveLength(3);
    const connectionFailure = presentProviderConnectionUsage({ sources: [keySource], isBillingSlotBound: () => true,
      view: view({ status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable') }, { 'key-usage': key }) });
    expect(connectionFailure.groups).toEqual(failed.groups);
    expect(connectionFailure.fetchedAt).toBe(1_000);
    expect(connectionFailure.connectionError?.code).toBe('provider_endpoint_unreachable');

    const never = presentProviderConnectionUsage({
      sources: [keySource],
      isBillingSlotBound: () => true,
      view: null,
    });
    expect([never.checked, never.groups, never.unsupported]).toEqual([
      false,
      [],
      false,
    ]);
    const unsupported = presentProviderConnectionUsage({
      sources: [keySource],
      isBillingSlotBound: () => true,
      view: view({ status: 'not_supported' }, {}),
    });
    expect([unsupported.checked, unsupported.unsupported]).toEqual([
      true,
      true,
    ]);
  });
});
