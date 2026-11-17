import { TELEMETRY_METRICS_READ_ACTION_ID_V1, TelemetryMetricsReadResultV1Schema,
  type TelemetryKeyFlowConfigV1, type TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';
import type { HappierSeries } from '@happier-dev/plugin-ui/presentation';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorUiActionExecutor, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/**
 * Read a saved telemetry Check's selected history from its collector on demand. The caller owns the shown
 * window and presented lifetime; the saved cadence/threshold and retained results do not define that history.
 * Recent bars and uptime continue to use the persisted check-result owner.
 */
export async function readTelemetryCheckHistory(
  input: Readonly<{ scope: ServerAccountScope; collectorMachineId: string; config: TelemetryKeyFlowConfigV1;
    since: number; until: number }>,
  execute = createFrontDoorUiActionExecutor(undefined, { serverId: input.scope.serverId, expectedAccountId: input.scope.accountId }),
  operation?: UiActionOperation,
): Promise<TelemetryMetricsReadResultV1> {
  const { environmentId, serviceName, serviceVersion, measure } = input.config;
  const read = await execute('action.invoke', {
    action: parseQualifiedPluginActionId(TELEMETRY_METRICS_READ_ACTION_ID_V1)!,
    input: { serverId: input.scope.serverId, environmentId, serviceName,
      ...(serviceVersion === undefined ? {} : { serviceVersion }), measure, since: input.since, until: input.until },
  }, { ...operation, externalActionTarget: { kind: 'machine', machineId: input.collectorMachineId } });
  return TelemetryMetricsReadResultV1Schema.parse(read);
}

/** The collector owns values, units and coverage; charts consume its natural intervals. */
export function readTelemetryMetricSeries(
  read: TelemetryMetricsReadResultV1,
  identity: Pick<HappierSeries, 'id' | 'label'>,
): Readonly<{
  series: HappierSeries;
  measurements: TelemetryMetricsReadResultV1['result']['measurements'];
}> {
  return {
    series: { id: identity.id, label: identity.label, points: read.trend.map(interval => ({
      id: JSON.stringify([interval.since, interval.until]), x: interval.until, y: interval.value ?? null,
    })) },
    measurements: read.result.measurements,
  };
}
