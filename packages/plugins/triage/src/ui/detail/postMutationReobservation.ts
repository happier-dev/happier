import { PluginError, type JsonValue, type PluginCancellationOptions, type PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';

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
import { deriveTriageDetailMountInstanceKey } from './mountKey.js';
import type { TriageTaskFieldChoicesV1, TriageTaskFieldsV1 } from '@happier-dev/triage-protocol/v1';

/** Transient values from the exact read; never part of a retained list row. */
export type TriageExactEntryReadV1 = Readonly<{ taskFields?: TriageTaskFieldsV1; taskFieldChoices?: TriageTaskFieldChoicesV1; detailData?: JsonValue }>;

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
 * canonical retained owner when that entry is already acquired. An exact-only surface uses the same
 * aggregate fold without creating list demand; no provider result or source-local fold participates. The mounted detail
 * must supply its lifetime signal so leaving or replacing that detail cancels the exact read and
 * makes a late answer inert.
 */
export async function reobserveTriagePostMutationRow(
  host: TriagePostMutationHostV1,
  row: TriageListRowV1 | Pick<TriageListRowV1, 'entryRef'>,
  lanes: readonly TriageListLaneV1[],
  sourceInstanceId: string,
  options: PluginCancellationOptions & Readonly<{
    sharedScope?: PluginEphemeralSharedScope | null;
    keepViewerFacts?: boolean;
    /** The source declares a directory for this kind: the opened detail asks for it in this one read. */
    includeTaskFieldChoices?: boolean;
    onReadFailure?: (error: unknown) => void;
    onExactRead?: (read: TriageExactEntryReadV1, observation: CorpusQualifiedObservationV1) => void;
    publishObservation?: (observation: CorpusQualifiedObservationV1, keepViewerFacts?: boolean) => TriageListRowV1 | null;
  }>,
): Promise<TriageListRowV1 | null> {
  const { keepViewerFacts, includeTaskFieldChoices, onReadFailure, onExactRead, publishObservation, sharedScope, ...cancellation } = options;
  const previous = 'observations' in row ? row : null;
  const prior = previous?.observations.find(
    (observation) => observation.sourceInstanceId === sourceInstanceId,
  );
  const lastKnownLocator = prior?.outcome.kind === 'present'
    ? prior.outcome.locator
    : previous?.content?.sourceInstanceId === sourceInstanceId
      ? previous.content.outcome.locator
      : undefined;
  let result: ReturnType<typeof TriageReobserveEntryResultV1Schema.parse>;
  try {
    const read = async (options: PluginCancellationOptions) => TriageReobserveEntryResultV1Schema.parse(await host.executeAction(
      TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
      {
        v: 1,
        entryRef: row.entryRef,
        sourceInstanceId,
        ...(onExactRead === undefined ? {} : { includeTaskFields: true, ...(includeTaskFieldChoices === true ? { includeTaskFieldChoices: true } : {}) }),
        ...(lastKnownLocator === undefined ? {} : { lastKnownLocator }),
      },
      options,
    ));
    if (sharedScope == null) {
      result = await read(cancellation);
    } else {
      cancellation.signal?.throwIfAborted();
      // Detail and companion artifacts share the pending exact read, never a
      // settled result. The existing host scope supplies Account and plugin
      // generation identity; the mount key supplies the exact entry
      // and configured connection. The last borrower cancels the source read.
      const lease = sharedScope.acquire(
        `triage.entry-read.v1:${deriveTriageDetailMountInstanceKey(row.entryRef, sourceInstanceId)}`,
        () => {
          const controller = new AbortController();
          return { value: read({ signal: controller.signal }), dispose: () => controller.abort() };
        },
      );
      if (lease == null) throw new PluginError({ code: 'unavailable' });
      const release = () => lease.release();
      cancellation.signal?.addEventListener('abort', release, { once: true });
      try {
        result = await lease.value;
      } finally {
        cancellation.signal?.removeEventListener('abort', release);
        release();
      }
    }
  } catch (error) {
    onReadFailure?.(error);
    return null;
  }
  if (result.kind !== 'observed') {
    onReadFailure?.(new PluginError({ code: result.kind === 'rejected' ? 'denied' : result.kind }));
    return null;
  }
  const observation: CorpusQualifiedObservationV1 = {
    entryRef: result.entryRef,
    ...result.observation,
  };
  if (options.signal?.aborted) return null;
  onExactRead?.({ ...(result.taskFields === undefined ? {} : { taskFields: result.taskFields }),
    ...(result.taskFieldChoices === undefined ? {} : { taskFieldChoices: result.taskFieldChoices }),
    ...(result.detailData === undefined ? {} : { detailData: result.detailData }) }, observation);
  const published = publishObservation?.(observation, keepViewerFacts);
  if (published != null) return published;
  return foldTriagePostMutationObservation({
    row: previous,
    observation,
    lanes,
    // The reobserve owner just admitted this active instance, even when the list has no successful lane.
    activeSourceInstanceIds: [...lanes.map(lane => lane.sourceInstanceId), sourceInstanceId],
    assembledAtMs: result.observation.observedAtMs,
    ...(keepViewerFacts === true ? { keepViewerFacts } : {}),
  });
}
