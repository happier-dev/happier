import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import {
  UsageWidgetBatchProvider,
  useUsageWidgetBatchSlices,
  useUsageWidgetModel,
} from './usageWidgetBatch';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';

const accounting: UsageAnalyticsQueryResponse = {
  v: 1,
  totals: {
    eventCount: 1,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 15,
    },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
  },
};
const scope = {
  period: { startMs: 1000 },
  agents: [],
  machines: [],
  projects: [],
  sources: [],
  session: null,
  costBasis: 'auto',
} as const;
const clauses = { granularity: 'day', timeZoneOffsetMinutes: 0 } as const;

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(() => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  home?.dispose();
  home = undefined;
});

/** The page chrome's view of the batch: one decoded Resource value for every mounted body. */
function BatchProbe(props: Readonly<{ batches: string[][] }>) {
  props.batches.push(useUsageWidgetBatchSlices().map((slice) => slice.key));
  return null;
}

function Body(
  props: Readonly<{
    name: string;
    metric: 'tokens' | 'cost';
    seen: Map<string, UsageWidgetBodyModel>;
  }>,
) {
  const { model } = useUsageWidgetModel({
    ...scope,
    metric: props.metric,
    breakdown: [],
  });
  props.seen.set(props.name, model);
  return null;
}

describe('Usage page batch', () => {
  it('serves every mounted body from one batched read: equal queries share a slice, distinct ones stay keyed apart', async () => {
    const batches: string[][] = [];
    home = await serveAccountHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://usage-batch.test',
          accountId: 'account-a',
        },
      ],
      route: (request) => {
        if (request.path !== '/v2/usage/query') return undefined;
        return Response.json(accounting);
      },
    });
    publishAppliedActiveServerSnapshot({
      serverId: home.homes.a!.id,
      serverUrl: home.homes.a!.serverUrl,
      generation: 0,
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      home.homes.a!.serverUrl,
    ))!;
    const seen = new Map<string, UsageWidgetBodyModel>();
    await renderScreen(
      <InjectedAuthProvider credentials={credentials}>
        <UsageWidgetBatchProvider clauses={clauses as never}>
          <Body name="daily" metric="tokens" seen={seen} />
          <Body name="summary" metric="tokens" seen={seen} />
          <Body name="costs" metric="cost" seen={seen} />
          <BatchProbe batches={batches} />
        </UsageWidgetBatchProvider>
      </InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 30 });
    const daily = seen.get('daily')!;
    const summary = seen.get('summary')!;
    const costs = seen.get('costs')!;
    expect(daily.slice?.accounting?.totals.tokens.total).toBe(15);
    // Equal resolved requests are one keyed slice; a different own metric is its own slice.
    expect(summary.slice).toBe(daily.slice);
    expect(costs.slice).not.toBeNull();
    expect(costs.slice?.key).not.toBe(daily.slice?.key);
    // Both keyed slices are members of the one page batch value (one `usage.query`), not two reads.
    expect(new Set(batches.at(-1))).toEqual(new Set([daily.slice!.key, costs.slice!.key]));
  });
});
