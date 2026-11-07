import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { storage } from '@/sync/domains/state/storage';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { readUsageWidgetQueryOverrides } from '../usageWidgetPageContext';
import { UsageWidgetBatchProvider, useUsageWidgetBatchInventorySlice, useUsageWidgetModel } from './usageWidgetBatch';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
  vi.restoreAllMocks();
});

it('updates filter inventory without rendering an unchanged visible widget', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(2_000);
  const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
  const scope = { period: { startMs: 1_000, endMs: 2_000 }, agents: [], machines: [], projects: [],
    sources: [], session: null, costBasis: 'auto' } as const;
  const clauses = readUsageWidgetQueryOverrides(normalizeUsageQuery({ granularity: 'day', timeZoneOffsetMinutes: 0 }));
  const inventoryRead = createDeferred<Response>();
  const heldRead = createDeferred<Response>();
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-inventory-render.test', accountId: 'account-a' }],
    route: request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return input.filters?.agentIds?.includes('claude') ? Response.json(accounting)
        : (input.filters?.agentIds?.includes('held') ? heldRead : inventoryRead).promise.then(response => response.clone());
    } });
  const server = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
    profile: AccountProfileSchema.parse({ id: 'account-a' }) });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl);
  const inventoryQuery = normalizeUsageQuery({ ...scope, includeComparison: false });
  let renders = 0;
  let model: UsageWidgetBodyModel | undefined;
  let inventory: ReturnType<typeof useUsageWidgetBatchInventorySlice>;
  function Widget() {
    renders++;
    model = useUsageWidgetModel({ ...scope, agents: ['claude'], metric: 'tokens', breakdown: [] }, 'usage_daily').model;
    return null;
  }
  function Inventory() { inventory = useUsageWidgetBatchInventorySlice(); return null; }
  function Held() { useUsageWidgetModel({ ...scope, agents: ['held'], metric: 'tokens', breakdown: [] }, 'usage_daily'); return null; }
  const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
    <UsageWidgetBatchProvider clauses={clauses} inventoryQuery={inventoryQuery}><Widget /><Inventory /><Held /></UsageWidgetBatchProvider>
  </InjectedAuthProvider>);
  try {
    await expect.poll(() => model?.slice?.accounting?.totals.eventCount).toBe(1);
    await flushHookEffects({ cycles: 20 });
    const before = renders;
    const slice = model!.slice;
    await act(async () => { inventoryRead.resolve(Response.json({ ...accounting, totals: { ...accounting.totals, eventCount: 3_423 } })); });
    await expect.poll(() => inventory?.accounting?.totals.eventCount).toBe(3_423);
    await flushHookEffects({ cycles: 20 });
    expect(model!.slice).toBe(slice);
    expect(renders - before, 'inventory progress renders zero unchanged widgets while a sibling is still reading').toBe(0);
  } finally { inventoryRead.resolve(Response.json(accounting)); heldRead.resolve(Response.json(accounting)); await screen.unmount(); }
});
