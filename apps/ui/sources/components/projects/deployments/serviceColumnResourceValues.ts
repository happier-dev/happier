import { admitPluginListFilterFieldValueV1, type AdmittedPluginListFilterFieldV1,
  type PluginServiceListFieldResourceResultV1 } from '@happier-dev/plugin-sdk/ui';

type ServiceColumnResourceRow = PluginServiceListFieldResourceResultV1['items'][number];
export type ServiceColumnValue = Readonly<Omit<ServiceColumnResourceRow, 'environmentId'>>;

/** The existing scalar admission owns value meaning; this adapter adds only Environment addressing. */
export function projectServiceColumnResourceValues(field: AdmittedPluginListFilterFieldV1,
  rows: readonly ServiceColumnResourceRow[]): ReadonlyMap<string, ServiceColumnValue> {
  const values = new Map<string, ServiceColumnValue>();
  for (const { environmentId, ...fact } of rows) {
    if (fact.value === null || admitPluginListFilterFieldValueV1(field.declaration, fact.value).kind === 'available') {
      values.set(environmentId, fact);
    }
  }
  return values;
}
