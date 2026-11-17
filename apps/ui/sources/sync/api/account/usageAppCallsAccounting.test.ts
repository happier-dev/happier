import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createTelemetryCollectorActionBoundary } from '@/dev/testkit/harness/telemetryCollectorActionBoundary';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { usageAppCallsSourceId } from '@/sync/domains/usage/usageAppCallsSource';

// HTTP serves the Account, its deployments, prices and the collector Machine's Action; Socket.IO cannot connect.
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
// The collector daemon's own RPC is an external boundary; Action admission and dispatch stay real.
const daemonRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemonRpc }));
await initializeRealAppRuntimeForTests();

const catalog: UsageModelPriceCatalog = {
  v: 1,
  models: {
    'gpt-5-mini': {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 4,
      cacheReadUsdPerMillion: 1,
      cacheWriteUsdPerMillion: 3,
    },
  },
  provenance: {
    source: 'litellm',
    origin: 'fetched',
    asOfMs: 1000,
    revision: 'catalog-nov-14',
    fetchStatus: 'ready',
  },
};
const tokens = {
  input: 1_000_000,
  output: 1_000_000,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 2_000_000,
};
const operand = (modelId: string, callCount: number) => ({
  bucketStartMs: 1_000,
  provider: 'vendor',
  modelId,
  requestedModel: modelId,
  operation: 'chat',
  callCount,
  tokens,
  tokenCategories: tokens,
  reportedCost: null,
  firstSeenMs: 1_000,
  lastSeenMs: 2_000,
});

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let withdrawProjection: (() => void) | undefined;
afterEach(async () => {
  withdrawProjection?.(); withdrawProjection = undefined;
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  await home?.dispose();
  home = undefined;
});

describe('Usage "Your apps" accounting', () => {
  it('reads the selected Environment from its collector and prices it with the shared catalog, never the Agents ledger', async () => {
    const collector = createTelemetryCollectorActionBoundary({
      machineId: 'collector-1',
      accountId: 'account-a',
      serverIdentityId: 'srv_usage_apps',
      readCosts: (input) => ({
        ok: true,
        source: input.source,
        since: input.since,
        until: input.until,
        items: [operand('gpt-5-mini', 3), operand('llama-3.3-70b', 1)],
        coverage: {
          callCount: 4,
          tokenCategoryCallCount: 4,
          reportedCostCallCount: 0,
          lostObservations: 0,
          reason: null,
        },
      }),
    });
    daemonRpc.mockImplementation(collector.answerDaemonRpc);
    home = await serveActionHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://usage-your-apps.test',
          accountId: 'account-a',
          serverIdentityId: 'srv_usage_apps',
          currentAccount: true,
        },
      ],
      route: async (request) => {
        if (request.path === '/v1/kv/bulk')
          return Response.json({ values: [] });
        if (request.path === '/v1/account/usage/prices')
          return Response.json(catalog);
        if (request.path === '/v2/usage/query')
          throw new Error(
            'App calls must never reach the Agents accounting read',
          );
        if (request.path === '/v1/deployments/environments')
          return Response.json({
            ok: true,
            nextCursor: null,
            coverage: 'complete',
            projectSources: [{ id: 'source-billing', name: 'billing-api' }],
            items: [
              {
                ...createDeploymentEnvironmentHeaderV1({
                  id: 'env-prod',
                  projectSourceId: 'source-billing',
                  telemetryMachineId: 'collector-1',
                }),
                name: 'Production',
              },
              {
                ...createDeploymentEnvironmentHeaderV1({
                  id: 'env-docs',
                  projectSourceId: 'source-billing',
                }),
                name: 'Docs',
              },
            ],
          });
        return collector.handle(request);
      },
    });
    const focused = home.homes.a!;
    withdrawProjection = collector.publishCommittedProjection(focused.id);
    publishAppliedActiveServerSnapshot({
      serverId: focused.id,
      serverUrl: focused.serverUrl,
      generation: 0,
    });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      focused.serverUrl,
    ))!;
    const { captureUiUsageQueryAccountContext, readUiUsageQueryBatch } =
      await import('./usageQueryResource');
    const context = captureUiUsageQueryAccountContext(credentials)!;
    const query = normalizeUsageQuery({
      period: { relative: '30days' },
      sources: [usageAppCallsSourceId('env-prod')],
      metric: 'cost',
      costBasis: 'api_equivalent',
      breakdown: ['source'],
      includeSessionEvidence: false,
      includeWorkEvidence: false,
      includeTranscriptEvidence: false,
      includeQuota: false,
      includeComparison: false,
    });
    const slice = (await readUiUsageQueryBatch(context, { queries: [query] }))
      .results[0]!;

    expect(collector.reads).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({
          kind: 'environment',
          environmentId: 'env-prod',
        }),
      }),
    ]);
    expect(slice.accounting?.totals.eventCount).toBe(4);
    // the priced operand (3 calls, 1M input + 1M output tokens) at the shared catalog: $2 + $4; the unlisted model keeps its tokens, never $0.
    expect(slice.costFactTotals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'api_equivalent', amountUsd: 6 }),
        expect.objectContaining({
          kind: 'unpriced',
          eventCount: 1,
          amountUsd: null,
        }),
      ]),
    );
    expect(slice.accounting?.priceCatalog?.provenance.revision).toBe(
      'catalog-nov-14',
    );
    expect(slice.accounting?.breakdowns?.source).toEqual([
      expect.objectContaining({
        key: usageAppCallsSourceId('env-prod'),
        label: 'Production',
      }),
    ]);
    expect(
      home.httpRequests.some((request) => request.path === '/v2/usage/query'),
    ).toBe(false);
  });
});
