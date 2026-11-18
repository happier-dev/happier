import { admitPluginListFilterFieldValueV1, PluginServiceListFieldResourceResultV1Schema,
  type AdmittedPluginListFilterFieldV1, type EntityFilterFactValueV1 } from '@happier-dev/plugin-sdk/ui';
import { DATABASE_CAPTURE_RESOURCE_REF_V1, DatabaseCaptureResourceSnapshotV1Schema,
  TELEMETRY_REQUESTS_FIELD_ID_V1, type TelemetryEnvironmentMetricsReadResultV1 } from '@happier-dev/database-protocol';

type Measurement = NonNullable<TelemetryEnvironmentMetricsReadResultV1['items'][number]['result']['measurements']>;
export type ServiceColumnValue = Readonly<{ value: EntityFilterFactValueV1;
  measurement?: Measurement; trend?: TelemetryEnvironmentMetricsReadResultV1['items'][number]['trend'] }>;
export function isTelemetryServiceColumnResource(resource: Readonly<{ pluginId: string; localId: string }>): boolean {
  return resource.pluginId === DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId
    && resource.localId === DATABASE_CAPTURE_RESOURCE_REF_V1.contributionId;
}

/** The existing scalar admission owns value meaning; this adapter adds only Environment addressing. */
export function projectServiceColumnResourceValues(resource: Readonly<{ pluginId: string; localId: string }>,
  field: AdmittedPluginListFilterFieldV1, input: unknown): ReadonlyMap<string, ServiceColumnValue> {
  const values = new Map<string, ServiceColumnValue>();
  if (isTelemetryServiceColumnResource(resource)) {
    if (field.declaration.id !== TELEMETRY_REQUESTS_FIELD_ID_V1) return values;
    const parsed = DatabaseCaptureResourceSnapshotV1Schema.safeParse(input);
    if (!parsed.success || parsed.data.view !== 'metrics') return values;
    for (const item of parsed.data.result.items) {
      const measurement = item.result.measurements;
      const admitted = admitPluginListFilterFieldValueV1(field.declaration,
        item.result.status === 'unknown' ? undefined : measurement?.value);
      values.set(item.environmentId, { value: admitted.kind === 'available' ? admitted.value : null, measurement, trend: item.trend });
    }
    return values;
  }
  const parsed = PluginServiceListFieldResourceResultV1Schema.safeParse(input);
  if (!parsed.success) return values;
  for (const item of parsed.data.items) {
    const admitted = admitPluginListFilterFieldValueV1(field.declaration, item.value);
    if (admitted.kind === 'available') values.set(item.environmentId, { value: admitted.value });
  }
  return values;
}
