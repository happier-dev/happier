import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { storage } from '@/sync/domains/state/storage';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { readUsageWidgetQueryOverrides } from '../usageWidgetPageContext';
import { UsageWidgetBatchProvider, useUsageWidgetBatchCostBasisOptions, useUsageWidgetBatchInventorySlice, useUsageWidgetModel } from './usageWidgetBatch';

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
  let eventCount = 1;
  let estimatedUsd = 0;
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-inventory-render.test', accountId: 'account-a' }],
    route: request => {
      if (request.path !== '/v2/usage/query') return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
      const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return input.filters?.agentIds?.some(id => id === 'claude' || id === 'codex')
        ? Response.json({ ...accounting, totals: { ...accounting.totals, eventCount,
          cost: { ...accounting.totals.cost, estimatedUsd } } })
        : (input.filters?.agentIds?.includes('held') ? heldRead : inventoryRead).promise.then(response => response.clone());
    } });
  const server = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
    profile: AccountProfileSchema.parse({ id: 'account-a' }) });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl);
  const inventoryQuery = normalizeUsageQuery({ ...scope, includeComparison: false });
  const renders = new Map<string, number>();
  const models = new Map<string, UsageWidgetBodyModel>();
  let inventory: ReturnType<typeof useUsageWidgetBatchInventorySlice>;
  let costChoices: ReturnType<typeof useUsageWidgetBatchCostBasisOptions> = [];
  let costChoiceRenders = 0;
  function CostChoices() { costChoiceRenders++; costChoices = useUsageWidgetBatchCostBasisOptions(); return null; }
  function Widget(props: Readonly<{ agent: string }>) {
    renders.set(props.agent, (renders.get(props.agent) ?? 0) + 1);
    models.set(props.agent, useUsageWidgetModel({ ...scope, agents: [props.agent], metric: 'tokens', breakdown: [] }, 'usage_daily').model);
    return null;
  }
  function Inventory() { inventory = useUsageWidgetBatchInventorySlice(); return null; }
  function Held() { useUsageWidgetModel({ ...scope, agents: ['held'], metric: 'tokens', breakdown: [] }, 'usage_daily'); return null; }
  const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
    <UsageWidgetBatchProvider clauses={clauses} inventoryQuery={inventoryQuery}><Widget agent="claude" /><Widget agent="codex" /><Inventory /><CostChoices /><Held /></UsageWidgetBatchProvider>
  </InjectedAuthProvider>);
  try {
    await expect.poll(() => [...models.values()].every(model => model.slice?.accounting?.totals.eventCount === 1)).toBe(true);
    await flushHookEffects({ cycles: 20 });
    const before = new Map(renders);
    const slices = new Map([...models].map(([id, model]) => [id, model.slice]));
    await act(async () => { inventoryRead.resolve(Response.json({ ...accounting, totals: { ...accounting.totals, eventCount: 3_423 } })); });
    await expect.poll(() => inventory?.accounting?.totals.eventCount).toBe(3_423);
    await flushHookEffects({ cycles: 20 });
    for (const [id, model] of models) {
      expect(model.slice).toBe(slices.get(id));
      expect(renders.get(id)! - before.get(id)!, `${id}: inventory progress renders zero unchanged widgets while a sibling is still reading`).toBe(0);
    }
    const inventoryRendersByWidget = Object.fromEntries([...renders].map(([id, count]) => [id, count - before.get(id)!]));
    // The quiet path must still carry an actual changed accounting result to both consumers.
    heldRead.resolve(Response.json(accounting));
    await flushHookEffects({ cycles: 20 });
    eventCount = 2;
    const beforeChange = new Map(renders);
    const beforeCostChoiceChange = costChoiceRenders;
    await act(async () => { await models.get('claude')!.refresh(); });
    await expect.poll(() => [...models.values()].every(model => model.slice?.accounting?.totals.eventCount === 2)).toBe(true);
    for (const [id, model] of models) {
      expect(model.slice).not.toBe(slices.get(id));
      expect(renders.get(id)! - beforeChange.get(id)!, `${id}: changed accounting renders its consumer`).toBeGreaterThan(0);
    }
    expect.soft(costChoiceRenders - beforeCostChoiceChange, 'unchanged cost choices do not execute chrome for changed accounting counts').toBe(0);
    console.info('USAGE-INVENTORY-SUBSCRIPTION', JSON.stringify({ inventoryRendersByWidget,
      unchangedCostChoiceRenders: costChoiceRenders - beforeCostChoiceChange,
      changedRendersByWidget: Object.fromEntries([...renders].map(([id, count]) => [id, count - beforeChange.get(id)!])) }));
    estimatedUsd = 2;
    const beforeCostModeChange = costChoiceRenders;
    await act(async () => { await models.get('claude')!.refresh(); });
    await expect.poll(() => costChoices.includes('estimated')).toBe(true);
    expect(costChoiceRenders - beforeCostModeChange, 'a newly available cost mode reaches its choice consumer').toBeGreaterThan(0);
  } finally { inventoryRead.resolve(Response.json(accounting)); heldRead.resolve(Response.json(accounting)); await screen.unmount(); }
});
