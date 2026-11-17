import { describe, expect, it } from 'vitest';
import { TELEMETRY_METRICS_READ_ACTION_ID_V1, type TelemetryKeyFlowConfigV1,
  type TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import * as metrics from './telemetryMetricSeries';

const config = { environmentId: 'checkout-prod', serviceName: 'checkout', serviceVersion: 'release-2',
  measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }], statistic: 'p95' },
  windowMs: 300_000, threshold: { operator: 'above', value: 500 } } satisfies TelemetryKeyFlowConfigV1;
const until = 2 * 86_400_000;
const since = until - 86_400_000;
const response = { result: { status: 'up', observedAt: until, evidence: { v: 1, items: [
  { source: { kind: 'entry', label: 'Collector metrics' }, author: { kind: 'process' }, text: 'Selected p95 is 80 ms.' },
] },
  measurements: { measure: 'p95', value: 80, unit: 'ms', basis: 'metric_points',
    producers: [{ serviceName: 'checkout', serviceVersion: 'release-2' }],
    window: { since, until }, completeness: 'partial', reasons: ['boundary_gap'] } }, routes: [],
  trend: [{ since, until: since + 1000, value: 80, unit: 'ms' },
    { since: since + 1000, until, unit: 'ms' }] } satisfies TelemetryMetricsReadResultV1;
const action = parseQualifiedPluginActionId(TELEMETRY_METRICS_READ_ACTION_ID_V1)!;
const selection = { serverId: 'home', environmentId: config.environmentId, serviceName: config.serviceName,
  serviceVersion: config.serviceVersion, since, until, measure: config.measure };
const scope = { serverId: 'home', accountId: 'reader' };

// The contributed invocation port is the daemon transport boundary. The UI front door and
// Protocol executor remain real, as do the public collector response and chart projections.
function transport(invoke: NonNullable<Parameters<typeof createActionExecutorBoundaryFixture>[0]>['invokeContributedAction']) {
  return createFrontDoorUiActionExecutor(createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
    invokeContributedAction: invoke,
  }), scope.accountId), { serverId: scope.serverId, expectedAccountId: scope.accountId });
}

describe('collector-selected Check history through the Action front door', () => {
  it('G1 control reads the collector Action through the existing real executor', async () => {
    const execute = transport(async () => ({ ok: true, result: response }));
    expect(await execute('action.invoke', { action, input: selection },
      { externalActionTarget: { kind: 'machine', machineId: 'collector-b' } })).toEqual(response);
  });

  it('reads the requested collector window, independent of saved check cadence and retained observations', async () => {
    const calls: unknown[] = [];
    const abort = new AbortController();
    const execute = transport(async request => {
      calls.push({ action: request.action, input: request.input, target: request.context.externalActionTarget,
        serverId: request.context.serverId, signal: request.signal });
      return { ok: true, result: response };
    });
    const read = await metrics.readTelemetryCheckHistory({ scope, collectorMachineId: 'collector-b', config, since, until },
      execute, { signal: abort.signal });
    expect(calls).toEqual([{ action, input: selection, target: { kind: 'machine', machineId: 'collector-b' },
      serverId: scope.serverId, signal: abort.signal }]);
    expect(read).toEqual(response);
    expect(metrics.readTelemetryMetricSeries(read, { id: 'checkout', label: 'Checkout' })).toMatchObject({
      series: { points: [{ x: since + 1000, y: 80 }, { x: until, y: null }] },
      measurements: { window: { since, until }, completeness: 'partial', reasons: ['boundary_gap'] },
    });
  });

  it('preserves a collector refusal instead of substituting retained check timing', async () => {
    const execute = transport(async () => ({ ok: false, errorCode: 'collector_unavailable', error: 'collector_unavailable' }));
    await expect(metrics.readTelemetryCheckHistory({ scope, collectorMachineId: 'collector-b', config, since, until }, execute))
      .rejects.toMatchObject({ code: 'collector_unavailable' });
  });
});
