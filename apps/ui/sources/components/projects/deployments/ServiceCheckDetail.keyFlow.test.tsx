import { afterEach, expect, it, vi } from 'vitest';
import { TELEMETRY_METRICS_READ_ACTION_ID_V1, type TelemetryKeyFlowConfigV1, type TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
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
const { ServiceCheckList } = await import('./ServiceCheckList');
const { ServiceCheckResponseTrend } = await import('./ServiceCheckResponseTrend');
const { StackedSeriesChart } = await import('@happier-dev/plugin-ui/presentation');
const { serviceCheckListFacts } = await import('./serviceCheckPresentation');
const { ServiceCheckCollectorTrendReaderContext } = await import('./useServiceCheckCollectorTrend');
const { readTelemetryCheckHistory } = await import('./telemetryMetricSeries');
const { createFrontDoorUiActionExecutor } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');

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

function row(kind: 'keyFlow' | 'http', config: TelemetryKeyFlowConfigV1 = keyFlow,
  latest: Readonly<{ status: 'down' | 'degraded' | 'unknown'; observedAt: number; latencyMs?: number; evidence: { kind: string } }> = {
    status: 'down', observedAt: NOW, latencyMs: 1420, evidence: { kind: 'none' },
  }) {
  return {
    kind: 'configuredCheck', key: `check-${kind}`, scope: { serverId: 'server-1', accountId: 'account-1' },
    automationId: `automation-${kind}`, triggerId: 'trigger-1',
    native: { name: 'Checkout', templateVersion: 1, enabled: true, triggers: [] },
    definitionFacts: { kind: 'available', observerMachineId: 'collector-b', checks: [{ checkId: 'c1', name: kind === 'keyFlow' ? 'Key flow' : 'HTTP',
      targetLabel: kind === 'keyFlow' ? 'POST /checkout, GET /api/cart' : 'shop.example', periodMs: 60_000, domainId: null,
      keyFlow: kind === 'keyFlow' ? config : null }] },
    lastResults: { kind: 'available', checks: [{ checkId: 'c1', result: latest,
      recentResults: [result(2, 'up', 380), result(1, 'down', 1380), latest], recentResultsCoverage: 'complete' }] },
  } as never;
}

const evidence: TelemetryMetricsReadResultV1['result']['evidence'] = { v: 1, items: [
  { source: { kind: 'entry', label: 'Collector metrics' }, author: { kind: 'process' }, text: 'Request history' },
] };
const read: TelemetryMetricsReadResultV1 = {
  result: { status: 'down', observedAt: NOW, evidence },
  routes: [
    { method: 'POST', route: '/checkout', result: { status: 'down', observedAt: NOW, evidence,
      measurements: { measure: 'p95', value: 1420, unit: 'ms', basis: 'metric_points', producers: [], window: { since: NOW - 24 * HOUR, until: NOW },
        completeness: 'complete', reasons: [], p95Ms: 1420, errorRate: 0.024, requestCount: 961 } } },
    { method: 'GET', route: '/api/cart', result: { status: 'up', observedAt: NOW, evidence,
      measurements: { measure: 'p95', value: 96, unit: 'ms', basis: 'metric_points', producers: [], window: { since: NOW - 24 * HOUR, until: NOW },
        completeness: 'complete', reasons: [], p95Ms: 96, errorRate: 0.003, requestCount: 2410 } } },
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

it('shows Unknown and no response line when the collector recorded no requests', async () => {
  const check = row('keyFlow', keyFlow, { status: 'unknown', observedAt: NOW, evidence });
  const scope = { serverId: 'server-1', accountId: 'account-1' };
  const reader = async () => ({
    ...read,
    result: { status: 'unknown' as const, observedAt: NOW, evidence },
    trend: read.trend.map(interval => ({ ...interval, value: 0, p95: 0, count: 0 })),
  });
  const screen = await renderScreen(
    <ServiceCheckCollectorTrendReaderContext.Provider value={reader}>
      <ItemList><ServiceCheckList rows={[check]} scope={scope} grouping="attention"
        selection={{ selectedKey: null, onSelect() {}, onSelectedRow() {} }}
        accessibilityLabel="Checks" testID="monitoring.checks" /></ItemList>
    </ServiceCheckCollectorTrendReaderContext.Provider>,
  );
  expect(screen.getTextContent()).toMatch(/health unknown/i);
  expect(screen.tree.root.findAllByType(StackedSeriesChart)).toHaveLength(0);
});

it('Monitoring plots collector p95 intervals when the saved check reports only error rate', async () => {
  const config: TelemetryKeyFlowConfigV1 = { ...keyFlow,
    measure: { ...keyFlow.measure, statistic: 'errorRate' }, threshold: { operator: 'above', value: 0.01 } };
  const check = row('keyFlow', config, { status: 'degraded', observedAt: NOW, evidence: { kind: 'none' } });
  const scope = { serverId: 'server-1', accountId: 'account-1' };
  const calls: unknown[] = [];
  // Retained R4 intervals include fractional ends and different intervals sharing an end.
  const ends = [1795772245844, 1795772247409.9998, 1795772247409.9998, 1795772248737];
  const starts = [1795772245827, 1795772245844, 1795772247397, 1795772247409.9998];
  const at = (timestamp: number) => NOW - 60_000 + (timestamp - ends[3]!);
  const intervals = ends.map((end, index) => ({ since: at(starts[index]!), until: at(end), count: index === 3 ? 2 : 1 }));
  const latencyHistory = intervals.map(interval => ({ ...interval, unit: 'ms', value: 4750, p95: 4750 }));
  const errorHistory = intervals.map(interval => ({ ...interval, unit: '1', value: 0.4, errorRate: 0.4 }));
  const executor = createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
    async invokeContributedAction(request) {
      calls.push({ action: request.action, target: request.context.externalActionTarget,
        serverId: request.context.serverId, input: request.input });
      const input = request.input as { measure: { statistic: string } };
      return { ok: true, result: { ...read, trend: input.measure.statistic === 'p95' ? latencyHistory : errorHistory } };
    },
  }), scope.accountId);
  const execute = createFrontDoorUiActionExecutor(executor, { serverId: scope.serverId, expectedAccountId: scope.accountId });
  const screen = await renderScreen(
    <ServiceCheckCollectorTrendReaderContext.Provider value={(input, signal) => readTelemetryCheckHistory(input, execute, { signal })}>
      <ItemList><ServiceCheckList rows={[check]} scope={scope} grouping="attention"
        selection={{ selectedKey: null, onSelect() {}, onSelectedRow() {} }}
        testID="monitoring-history" accessibilityLabel="Monitoring" /></ItemList>
    </ServiceCheckCollectorTrendReaderContext.Provider>,
  );
  const id = 'services.checks.row.automation-keyFlow.trigger-1';
  expect(screen.findByTestId(`${id}:column:recent`)).not.toBeNull();
  expect(screen.findByTestId(`${id}:column:uptime`)).not.toBeNull();
  await vi.waitFor(() => expect(screen.tree.root.findByType(StackedSeriesChart).props.series).toEqual([
    expect.objectContaining({ points: latencyHistory.map(interval => ({
      id: JSON.stringify([interval.since, interval.until]), x: interval.until, y: interval.p95,
    })) }),
  ]));
  expect(calls).toEqual([{
    action: parseQualifiedPluginActionId(TELEMETRY_METRICS_READ_ACTION_ID_V1),
    target: { kind: 'machine', machineId: 'collector-b' },
    serverId: scope.serverId,
    input: { serverId: scope.serverId, environmentId: config.environmentId, serviceName: config.serviceName,
      measure: { ...config.measure, statistic: 'p95' }, since: NOW - 24 * HOUR, until: NOW },
  }]);
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

// P8 U2: Monitoring's Response leads with the saved check's own result (its value, window and limit), and names the
// collector history beside it as separately windowed, so the failing value is said once.
it('leads a Key flow row’s Response with the saved result and names the collector history’s scope', async () => {
  const { reader } = recordingReader();
  const latest = { status: 'down' as const, observedAt: NOW, latencyMs: 1420, evidence: { kind: 'none' },
    measurements: { measure: 'p95', value: 1420, unit: 'ms', basis: 'metric_points', producers: [],
      window: { since: NOW - 600_000, until: NOW }, completeness: 'complete', reasons: [] } };
  const check = row('keyFlow', keyFlow, latest);
  const facts = serviceCheckListFacts(check);
  const screen = await renderScreen(
    <ServiceCheckCollectorTrendReaderContext.Provider value={reader}>
      <ItemList><ServiceCheckList rows={[check]} scope={{ serverId: 'server-1', accountId: 'account-1' }} grouping="attention"
        selection={{ selectedKey: null, onSelect() {}, onSelectedRow() {} }}
        testID="monitoring-response" accessibilityLabel="Monitoring" /></ItemList>
    </ServiceCheckCollectorTrendReaderContext.Provider>,
  );
  const cell = screen.findByTestId('services.checks.row.automation-keyFlow.trigger-1:column:response');
  expect(facts.valueText).not.toBeNull();
  expect(facts.ruleText).not.toBeNull();
  const readout = cell?.findAll(node => typeof node.props.accessibilityLabel === 'string')[0]?.props.accessibilityLabel;
  expect(readout).toBe([facts.valueText, facts.ruleText, 'Collector history · 24 h'].join(' · '));
  // The failing value is said once on the row.
  expect(screen.getTextContent().split(facts.valueText!).length - 1).toBe(1);
});
