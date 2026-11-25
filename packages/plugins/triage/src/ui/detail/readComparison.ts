import type { PluginUiHostApi, PluginUiTargetedContributionOperationV1 } from '@happier-dev/plugin-sdk/ui';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { TriageGetResultV1Schema, type TriageDetailSurfaceInputV1, type TriageEntryRefV1, type TriageEntryLocatorV1 } from '@happier-dev/triage-protocol/v1';

/** Read transient comparison evidence only through the selected source's admitted get operation. */
export async function readTriageComparisonSource(input: Readonly<{
  host: Pick<PluginUiHostApi, 'executeAction'>;
  read?: Readonly<{ operation: PluginUiTargetedContributionOperationV1; instance: TriageDetailSurfaceInputV1['instance'] }>;
  entryRef: TriageEntryRefV1;
  lastKnownLocator?: TriageEntryLocatorV1;
  signal?: AbortSignal;
}>) {
  if (!input.read || input.signal?.aborted) return undefined;
  const { entryRef: entry, read } = input;
  const localRef = { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId };
  const result = TriageGetResultV1Schema.safeParse(await input.host.executeAction(read.operation.action, {
    v: 1, instance: read.instance, localRef,
    ...(input.lastKnownLocator === undefined ? {} : { lastKnownLocator: input.lastKnownLocator }),
  }, input.signal ? { signal: input.signal } : undefined));
  if (input.signal?.aborted || !result.success || !pluginJsonValuesEqual(result.data.localRef, localRef)) return undefined;
  if (result.data.kind === 'unresolved') throw result.data.failure;
  return result.data.kind === 'present' ? result.data.comparisonSource : undefined;
}
