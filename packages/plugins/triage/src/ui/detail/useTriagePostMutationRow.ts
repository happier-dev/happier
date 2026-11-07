import * as React from 'react';
import { isPluginError, type PluginError } from '@happier-dev/plugin-sdk';
import { usePluginHostApi, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';

import type { TriageListLaneV1, TriageListRowV1 } from '../../projection/listWindow.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { deriveTriageDetailMountInstanceKey } from './mountKey.js';
import { reobserveTriagePostMutationRow, type TriageExactEntryReadV1 } from './postMutationReobservation.js';
import type { TriageSurfaceSelectionV1 } from '../state/surface.js';
import type { TriageListWindowStoreV1 } from '../../projection/listWindowStore.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import type { CorpusQualifiedObservationV1 } from '../../corpus/fold/qualify.js';

/** Acquired entries publish to the retained owner; exact-only opens keep their separate read scope. */
export function useTriagePostMutationRow(
  windowRow: TriageListRowV1 | null,
  lanes: readonly TriageListLaneV1[],
  /** An admitted explicit open may precede this mount's first observation. */
  unobservedSelection?: TriageSurfaceSelectionV1 | null,
  publication?: TriageListWindowStoreV1 | null,
) {
  const hostApi = usePluginHostApi();
  const sharedScope = usePluginUiEphemeralSharedScope();
  const selectedFromWindow = React.useMemo(
    () => windowRow === null ? null : readTriageSelectedObservationV1(windowRow),
    [windowRow],
  );
  const entryRef = windowRow?.entryRef ?? unobservedSelection?.entryRef;
  const sourceInstanceId = selectedFromWindow?.sourceInstanceId ?? unobservedSelection?.sourceInstanceId;
  const ownerKey = entryRef === undefined || sourceInstanceId === undefined
    ? null
    : deriveTriageDetailMountInstanceKey(entryRef, sourceInstanceId);
  const [state, setState] = React.useState<Readonly<{
    ownerKey: string | null;
    generation: number;
    row: TriageListRowV1 | null;
    readFailed: boolean;
    failure?: PluginError;
    exactRead: TriageExactEntryReadV1 | null;
  }>>({ ownerKey, generation: 0, row: null, readFailed: false, exactRead: null });
  // Retire A before even one render can combine B's selection with A's observation.
  if (state.ownerKey !== ownerKey) {
    setState({ ownerKey, generation: state.generation + 1, row: null, readFailed: false, exactRead: null });
  }
  const reobservation = React.useRef<AbortController | null>(null);
  const readObservation = React.useRef<Readonly<{
    ownerKey: string | null; observedAtMs?: number; sourceUpdatedAtMs?: number; nativeRevision?: string;
  }> | null>(null);
  const row = state.ownerKey === ownerKey ? state.row ?? windowRow : windowRow;
  const reobserveRow = React.useCallback(async (
    candidate: TriageListRowV1 | null,
    keepViewerFacts = false,
  ): Promise<void> => {
    if (entryRef === undefined || sourceInstanceId === undefined) return;
    const lifecycleGeneration = state.generation;
    const requested = candidate === null ? null : readTriageSelectedObservationV1(candidate);
    // A failed read still spends this publication's demand; Retry remains explicit.
    readObservation.current = { ownerKey, observedAtMs: requested?.observation.observedAtMs,
      sourceUpdatedAtMs: requested?.observation.sourceUpdatedAtMs, nativeRevision: requested?.observation.nativeRevision };
    reobservation.current?.abort();
    const controller = new AbortController();
    reobservation.current = controller;
    setState(current => current.ownerKey === ownerKey && current.readFailed ? { ...current, readFailed: false } : current);
    let failure: PluginError | undefined;
    let exactRead: TriageExactEntryReadV1 | null = null;
    const next = await reobserveTriagePostMutationRow(hostApi, candidate ?? { entryRef }, lanes, sourceInstanceId, {
      signal: controller.signal,
      // Mounts share their opening read; an explicit refresh or completed write
      // must observe after that action, even while another mount is still opening.
      ...(keepViewerFacts ? { sharedScope } : {}),
      keepViewerFacts,
      onExactRead: (read, observation) => {
        exactRead = read;
        // Record before publishing, so this read's own row cannot reopen it.
        const prior = readObservation.current;
        if (observation.outcome.kind === 'present'
          && (prior?.sourceUpdatedAtMs === undefined || observation.outcome.sourceUpdatedAtMs === undefined
            || observation.outcome.sourceUpdatedAtMs >= prior.sourceUpdatedAtMs)) {
          readObservation.current = { ownerKey, observedAtMs: observation.observedAtMs,
            sourceUpdatedAtMs: observation.outcome.sourceUpdatedAtMs, nativeRevision: observation.outcome.nativeRevision };
        }
      },
      ...(publication == null ? {} : { publishObservation: (observation: CorpusQualifiedObservationV1, preserveViewerFacts?: boolean) =>
        publication.publishObservation(observation, preserveViewerFacts) }),
      onReadFailure: (error) => { if (isPluginError(error)) failure = error; },
    });
    if (!controller.signal.aborted && reobservation.current === controller) {
      const retained = next === null ? null : publication?.getRow(triageEntryRowKey(next.entryRef));
      // The retained owner is unfiltered. A selected entry outside the current
      // window still needs its exact result to open the subscribed detail.
      const publishedInWindow = windowRow !== null && next !== null && retained === next;
      setState((current) => current.ownerKey !== ownerKey || current.generation !== lifecycleGeneration
        ? current
        : { ...current, ...(next === null || publishedInWindow ? {} : { row: next }), exactRead,
          readFailed: next === null, failure });
    }
    if (reobservation.current === controller) reobservation.current = null;
  }, [entryRef, hostApi, lanes, ownerKey, publication, sharedScope, sourceInstanceId, state.generation, windowRow]);
  const completePostMutation = React.useCallback(() => reobserveRow(row === null ? row
    : publication?.getRow(triageEntryRowKey(row.entryRef)) ?? row), [publication, reobserveRow, row]);
  const reobserveSelection = React.useEffectEvent(() => reobserveRow(windowRow, true));
  React.useEffect(() => {
    setState((current) => current.ownerKey === ownerKey && (current.row !== null || current.readFailed)
      ? { ...current, row: null, readFailed: false } : current);
  }, [ownerKey, windowRow]);
  React.useEffect(() => {
    // Opening a selected owner reads its exact facts once. Later retained publications
    // are those facts, including this read's own result; explicit refresh and source
    // completion already invoke the shared callback rather than reopening this lifecycle.
    void reobserveSelection();
    return () => {
      reobservation.current?.abort();
      reobservation.current = null;
    };
  }, [ownerKey]);
  const sourceUpdatedAtMs = selectedFromWindow?.observation.sourceUpdatedAtMs;
  const nativeRevision = selectedFromWindow?.observation.nativeRevision;
  const observedAtMs = selectedFromWindow?.observation.observedAtMs;
  React.useEffect(() => {
    const read = readObservation.current;
    if (ownerKey === null || read?.ownerKey !== ownerKey) return;
    // External source changes refresh full fields through this same owner.
    // A later read stamp alone is merely a retained publication, not new demand.
    if ((sourceUpdatedAtMs !== undefined && (read.sourceUpdatedAtMs === undefined || sourceUpdatedAtMs > read.sourceUpdatedAtMs))
      || (nativeRevision !== undefined && nativeRevision !== read.nativeRevision
        && observedAtMs !== undefined && (read.observedAtMs === undefined || observedAtMs > read.observedAtMs))) {
      void reobserveSelection();
    }
  }, [ownerKey, sourceUpdatedAtMs, nativeRevision, observedAtMs, state.exactRead]);
  return { row, completePostMutation, exactRead: state.ownerKey === ownerKey ? state.exactRead : null,
    readFailed: state.ownerKey === ownerKey && state.readFailed,
    failure: state.ownerKey === ownerKey && state.readFailed ? state.failure : undefined };
}
