import { admitPluginListFilterFieldValueV1, type AdmittedPluginListFilterFieldV1,
  type PluginServiceListFieldResourceResultV1 } from '@happier-dev/plugin-sdk/ui';

type ServiceColumnResourceRow = PluginServiceListFieldResourceResultV1['items'][number];
export type ServiceColumnValue = Readonly<Omit<ServiceColumnResourceRow, 'environmentId' | 'facts'>>;

/** The existing scalar admission owns value meaning; this adapter adds only Environment addressing. */
export function projectServiceColumnResourceValues(field: AdmittedPluginListFilterFieldV1,
  rows: readonly ServiceColumnResourceRow[]): ReadonlyMap<string, ServiceColumnValue> {
  const values = new Map<string, ServiceColumnValue>();
  const { byline, column: columnPlacement, id } = field.declaration;
  for (const { environmentId, facts, ...column } of rows) {
    const keyedFact = byline ? facts?.[id] : undefined;
    const fact = keyedFact ?? (columnPlacement || !byline ? column : undefined);
    if (!fact) continue;
    if (fact.value === null || admitPluginListFilterFieldValueV1(field.declaration, fact.value).kind === 'available') {
      values.set(environmentId, fact);
    }
  }
  return values;
}
