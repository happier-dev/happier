import { afterEach, expect, it } from 'vitest';
import type { TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The real sync owner under the canonical Account/RPC boundary; the collector read is the network edge, supplied
// through the reader context the way the Action front door would answer it.
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { ServiceCheckDetail } = await import('./ServiceCheckDetail');
const { ServiceCheckResponseTrend } = await import('./ServiceCheckResponseTrend');
const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
const { ServiceCheckCollectorTrendReaderContext } = await import('./useServiceCheckCollectorTrend');

afterEach(async () => {
  standardCleanup();
  await account.reset();
  rpc.reset();
});

const NOW = Date.UTC(2026, 10, 17, 19, 52);
const HOUR = 3_600_000;
const keyFlow = {
  environmentId: 'env-prod', serviceName: 'billing-api',
  measure: { kind: 'route' as const, routes: [{ method: 'POST', route: '/checkout' }, { method: 'GET', route: '/api/cart' }], statistic: 'p95' as const },
  windowMs: 600_000, threshold: { operator: 'above' as const, value: 800 },
};
const result = (minutesAgo: number, status: 'up' | 'down', latencyMs: number) =>
  ({ status, observedAt: NOW - minutesAgo * 60_000, latencyMs, evidence: { kind: 'none' } });

function row(kind: 'keyFlow' | 'http') {
  return {
    kind: 'configuredCheck', key: `check-${kind}`, scope: { serverId: 'server-1', accountId: 'account-1' },
    automationId: `automation-${kind}`, triggerId: 'trigger-1',
    native: { name: 'Checkout', templateVersion: 1, enabled: true, triggers: [] },
    definitionFacts: { kind: 'available', observerMachineId: 'collector-b', checks: [{ checkId: 'c1', name: kind === 'keyFlow' ? 'Key flow' : 'HTTP',
      targetLabel: kind === 'keyFlow' ? 'POST /checkout, GET /api/cart' : 'shop.example', periodMs: 60_000, domainId: null,
      keyFlow: kind === 'keyFlow' ? keyFlow : null }] },
    lastResults: { kind: 'available', checks: [{ checkId: 'c1', result: result(0, 'down', 1420),
      recentResults: [result(2, 'up', 380), result(1, 'down', 1380), result(0, 'down', 1420)], recentResultsCoverage: 'complete' }] },
  } as never;
}

const read: TelemetryMetricsReadResultV1 = {
  result: { status: 'down', observedAt: NOW, evidence: { v: 1, items: [] } } as never,
  routes: [
    { method: 'POST', route: '/checkout', result: { status: 'down', observedAt: NOW, evidence: { v: 1, items: [] },
      measurements: { measure: 'p95', value: 1420, unit: 'ms', basis: 'metric_points', producers: [], window: { since: NOW - 24 * HOUR, until: NOW },
        completeness: 'complete', reasons: [], p95Ms: 1420, errorRate: 0.024, requestCount: 961 } } as never },
    { method: 'GET', route: '/api/cart', result: { status: 'up', observedAt: NOW, evidence: { v: 1, items: [] },
      measurements: { measure: 'p95', value: 96, unit: 'ms', basis: 'metric_points', producers: [], window: { since: NOW - 24 * HOUR, until: NOW },
        completeness: 'complete', reasons: [], p95Ms: 96, errorRate: 0.003, requestCount: 2410 } } as never },
  ],
  trend: [
    { since: NOW - 3 * HOUR, until: NOW - 2 * HOUR, unit: 'ms', value: 310, p95: 310, errorRate: 0.003, count: 400 },
    { since: NOW - 2 * HOUR, until: NOW - HOUR, unit: 'ms', value: 330, p95: 330, errorRate: 0.002, count: 420 },
    { since: NOW - HOUR, until: NOW, unit: 'ms', value: 1420, p95: 1420, errorRate: 0.024, count: 380 },
  ],
};

function recordingReader() {
  const calls: unknown[] = [];
  const reader = async (input: unknown) => { calls.push(input); return read; };
  return { calls, reader };
}

// J5 / D33: the check page's Key flow section reads the collector that runs it, once, over the 24 hours before its
// newest persisted result, and draws its trend and routes from that one read.
it('opens a Key flow check and reads its trend and routes from its collector once', async () => {
  const { calls, reader } = recordingReader();
  const screen = await renderScreen(
    <ServiceCheckCollectorTrendReaderContext.Provider value={reader}>
      <ItemList><ServiceCheckDetail row={row('keyFlow')} nowMs={NOW} /></ItemList>
    </ServiceCheckCollectorTrendReaderContext.Provider>,
  );
  expect(calls).toEqual([{ scope: { serverId: 'server-1', accountId: 'account-1' }, collectorMachineId: 'collector-b', config: keyFlow,
    since: NOW - 24 * HOUR, until: NOW }]);
  expect(screen.findHostByTestId('services.check.keyFlow.latency')).toBeTruthy();
  expect(screen.findHostByTestId('services.check.keyFlow.route.POST /checkout')).toBeTruthy();
  // The retained check timings no longer draw a second response chart for a Key flow.
  expect(screen.findHostByTestId('services.check.response')).toBeFalsy();
});

it('every other check keeps its retained response chart and reads no collector', async () => {
  const { calls, reader } = recordingReader();
  const screen = await renderScreen(
    <ServiceCheckCollectorTrendReaderContext.Provider value={reader}>
      <ItemList><ServiceCheckDetail row={row('http')} nowMs={NOW} /></ItemList>
    </ServiceCheckCollectorTrendReaderContext.Provider>,
  );
  expect(calls).toEqual([]);
  expect(screen.findHostByTestId('services.check.response')).toBeTruthy();
  expect(screen.findHostByTestId('services.check.keyFlow.trend')).toBeFalsy();
});

// R2-B: Monitoring's Response · 24 h for a Key flow is the collector's history, not the retained check timings.
it('draws a Key flow row’s 24-hour response from the collector, not from its retained results', async () => {
  const { calls, reader } = recordingReader();
  const facts = serviceCheckListFacts(row('keyFlow'));
  await renderScreen(
    <ServiceCheckCollectorTrendReaderContext.Provider value={reader}>
      <ServiceCheckResponseTrend facts={facts} scope={{ serverId: 'server-1', accountId: 'account-1' }} form="line" label="Response · 24 h" />
    </ServiceCheckCollectorTrendReaderContext.Provider>,
  );
  expect(calls).toHaveLength(1);
  expect(facts.response24h).toEqual([]);
});
