import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';

import type { CorpusQualifiedObservationV1 } from '../../corpus/fold/qualify.js';
import {
  foldTriagePostMutationObservation,
  type TriageListLaneV1,
  type TriageListRowV1,
} from '../../projection/listWindow.js';
import {
  TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
  TriageReobserveEntryResultV1Schema,
} from '../../actions/reobserveEntryProtocol.js';

type TriagePostMutationHostV1 = Readonly<{
  executeAction(
    action: string,
    input: JsonValue,
    options?: PluginCancellationOptions,
  ): Promise<unknown>;
}>;

/**
 * The mounted target's complete post-mutation sequence.
 *
 * Source renderers signal only that a potentially changing Action settled. This target callback
 * invokes the exact configured-source `get` Action and feeds its qualified answer through the
 * canonical aggregate fold. It returns one row which the parent supplies to both its common header
 * and its targeted child; no provider result or source-local fold participates. The mounted detail
 * must supply its lifetime signal so leaving or replacing that detail cancels the exact read and
 * makes a late answer inert.
 */
export async function reobserveTriagePostMutationRow(
  host: TriagePostMutationHostV1,
  row: TriageListRowV1,
  lanes: readonly TriageListLaneV1[],
  sourceInstanceId: string,
  options: PluginCancellationOptions,
): Promise<TriageListRowV1 | null> {
  const prior = row.observations.find(
    (observation) => observation.sourceInstanceId === sourceInstanceId,
  );
  const lastKnownLocator = prior?.outcome.kind === 'present'
    ? prior.outcome.locator
    : undefined;
  let result: ReturnType<typeof TriageReobserveEntryResultV1Schema.parse>;
  try {
    result = TriageReobserveEntryResultV1Schema.parse(await host.executeAction(
      TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
      {
        v: 1,
        entryRef: row.entryRef,
        sourceInstanceId,
        ...(lastKnownLocator === undefined ? {} : { lastKnownLocator }),
      },
      options,
    ));
  } catch {
    return null;
  }
  if (result.kind !== 'observed') return null;
  const observation: CorpusQualifiedObservationV1 = {
    entryRef: result.entryRef,
    ...result.observation,
  };
  return foldTriagePostMutationObservation({
    row,
    observation,
    lanes,
    assembledAtMs: result.observation.observedAtMs,
  });
}
