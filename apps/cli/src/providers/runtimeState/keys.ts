import {
  serializeProviderCatalogRuntimeStateKeyV1,
  serializeProviderEndpointRuntimeStateKeyV1,
  serializeProviderInstallationRuntimeStateKeyV1,
  serializeProviderModelLoadRuntimeStateKeyV1,
  type ProviderCatalogRuntimeStateRecordV1,
  type ProviderEndpointRuntimeStateRecordV1,
  type ProviderInstallationRuntimeStateRecordV1,
  type ProviderModelLoadRuntimeStateRecordV1,
} from '@happier-dev/protocol';

export type ProviderRuntimeStateRecordKind =
  | 'endpointHealth'
  | 'catalogs'
  | 'installationChecks'
  | 'modelLoadStates';

export type ProviderRuntimeStateRecordByKind = Readonly<{
  endpointHealth: ProviderEndpointRuntimeStateRecordV1;
  catalogs: ProviderCatalogRuntimeStateRecordV1;
  installationChecks: ProviderInstallationRuntimeStateRecordV1;
  modelLoadStates: ProviderModelLoadRuntimeStateRecordV1;
}>;

export function serializeProviderRuntimeStateRecordKey<K extends ProviderRuntimeStateRecordKind>(
  kind: K,
  record: Pick<ProviderRuntimeStateRecordByKind[K], 'key'>,
): string {
  switch (kind) {
    case 'endpointHealth':
      return serializeProviderEndpointRuntimeStateKeyV1(record.key);
    case 'catalogs':
      return serializeProviderCatalogRuntimeStateKeyV1(record.key);
    case 'installationChecks':
      return serializeProviderInstallationRuntimeStateKeyV1(record.key);
    case 'modelLoadStates':
      return serializeProviderModelLoadRuntimeStateKeyV1(record.key);
  }
}

export function replaceProviderRuntimeStateRecord<K extends ProviderRuntimeStateRecordKind>(
  kind: K,
  records: readonly ProviderRuntimeStateRecordByKind[K][],
  next: ProviderRuntimeStateRecordByKind[K],
): readonly ProviderRuntimeStateRecordByKind[K][] {
  const nextKey = serializeProviderRuntimeStateRecordKey(kind, next);
  const matchingIndexes: number[] = [];
  records.forEach((record, index) => {
    if (serializeProviderRuntimeStateRecordKey(kind, record) === nextKey) matchingIndexes.push(index);
  });
  if (matchingIndexes.length > 1) {
    throw new TypeError(`Provider runtime-state ${kind} contains a duplicate semantic key`);
  }
  if (matchingIndexes.length === 0) return [...records, next];
  return records.map((record, index) => index === matchingIndexes[0] ? next : record);
}

export function compareProviderRuntimeStateRecordKeys<K extends ProviderRuntimeStateRecordKind>(
  kind: K,
  left: Pick<ProviderRuntimeStateRecordByKind[K], 'key'>,
  right: Pick<ProviderRuntimeStateRecordByKind[K], 'key'>,
): number {
  const leftKey = serializeProviderRuntimeStateRecordKey(kind, left);
  const rightKey = serializeProviderRuntimeStateRecordKey(kind, right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
