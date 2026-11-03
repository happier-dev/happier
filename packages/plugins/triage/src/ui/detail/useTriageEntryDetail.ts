import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../../accountExecution.js';
import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { usePluginHostApi, usePluginHostReadiness } from '@happier-dev/plugin-ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageLinkedSessionProjectionV1,
} from '@happier-dev/triage-protocol/v1';

import {
  TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
  type TriageReadEntryDetailInputV1,
  type TriageReadEntryDetailResultV1,
  TriageReadEntryDetailResultV1Schema,
} from '../../actions/entryDetailProtocol.js';
import type { TriageSurfaceSelectionV1 } from '../state/surface.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';
import { buildTriageDetailSurfaceInputV1 } from './input.js';

/**
 * The selected entry's mounted detail input.
 *
 * The Account Action supplies the configured connection and links through the
 * composed relation owner. The UI does not select relation ownership from its
 * local descriptor snapshot or open a parallel raw corpus reader. The applied
 * observation remains in the reader's device-local projection and is passed in.
 *
 * Descriptor and operation/surface facts deliberately do not travel through
 * this Action. The physical mount's exact targeted snapshot owns them, leaving
 * this durable read available when no daemon is reachable.
 *
 * Every state it can be in is one a reader can be told truthfully, and the
 * unavailable ones are deliberately distinguishable: a connection that has been
 * removed is a different sentence from an Account this device cannot currently
 * reach, and both are different from a value the published contract refused.
 * Collapsing them would leave the detail region with one shrug for three causes.
 */

export type TriageEntryDetailStateV1 =
  | Readonly<{ kind: 'reading' }>
  | Readonly<{
    kind: 'ready';
    input: TriageDetailSurfaceInputV1;
    /** Every linked Session page this mount has answered, in Collection order. */
    linkedSessions: readonly TriageLinkedSessionProjectionV1[];
    /** The opaque Collection continuation, held only for this mount. */
    linkedSessionsNextCursor?: string;
    linkedSessionsPageState: 'idle' | 'loading' | 'failed';
    loadMoreLinkedSessions(): void;
  }>
  /** The selected connection is retired, removed, or no longer this source's. */
  | Readonly<{ kind: 'unavailable' }>
  /** Detail preparation failed; Retry or host re-admission can read it again. */
  | Readonly<{ kind: 'unreachable' }>
  /**
   * The durable facts read cleanly and still could not compose an admissible
   * detail input — an over-bound Session projection, or an observation that no
   * longer names the selected entry. It is not a source failure and is never
   * reported as one.
   */
  | Readonly<{ kind: 'refused'; reason: 'entryMismatch' | 'instanceMismatch' | 'invalidContractValue' }>;

/** The mounted form adds the reader's one recovery action to read failure. */
export type TriageMountedEntryDetailStateV1 =
  | Exclude<TriageEntryDetailStateV1, Readonly<{ kind: 'unreachable' | 'ready' }>>
  | (Extract<TriageEntryDetailStateV1, Readonly<{ kind: 'ready' }>> & Readonly<{
    /** An explicit relationship change starts a fresh authoritative linked-Session walk. */
    refreshLinkedSessions(): void;
  }>)
  | Readonly<{ kind: 'unreachable'; retry(): void }>;

const READING = Object.freeze({ kind: 'reading' } satisfies TriageEntryDetailStateV1);
const UNAVAILABLE = Object.freeze({ kind: 'unavailable' } satisfies TriageEntryDetailStateV1);
const UNREACHABLE = Object.freeze({ kind: 'unreachable' } satisfies TriageEntryDetailStateV1);

/** Settle any cursor this mounted walk already spent, including A→B→A. */
/**
 * A re-read of the entry the reader already has open answers its FIRST linked-Session page again. The pages the
 * reader loaded after it are still theirs: they stay, after the fresh first page and without repeats, and the
 * walk continues from where the reader left it. A different entry or connection starts over.
 */
export function keepLoadedLinkedSessionPagesV1<State extends TriageEntryDetailStateV1>(
  retained: TriageEntryDetailStateV1 | null,
  next: State,
): State {
  if (retained?.kind !== 'ready' || next.kind !== 'ready') return next;
  if (!sameTriageEntryRefV1(retained.input.observation.entryRef, next.input.observation.entryRef)
    || retained.input.instance.instance.sourceInstanceId !== next.input.instance.instance.sourceInstanceId) return next;
  if (retained.linkedSessions.length <= next.linkedSessions.length) return next;
  const fresh = new Set(next.linkedSessions.map((session) => session.sessionId));
  const linkedSessions = Object.freeze([
    ...next.linkedSessions,
    ...retained.linkedSessions.filter((session) => !fresh.has(session.sessionId)),
  ]);
  const { linkedSessionsNextCursor: _firstPageCursor, ...rest } = next;
  return Object.freeze({
    ...rest,
    linkedSessions,
    ...(retained.linkedSessionsNextCursor === undefined ? {} : { linkedSessionsNextCursor: retained.linkedSessionsNextCursor }),
  }) as State;
}

export function isSpentTriageLinkedSessionCursorV1(
  spent: ReadonlySet<string>,
  nextCursor: string | undefined,
): boolean {
  return nextCursor !== undefined && spent.has(nextCursor);
}

/** What this read needs from a mount: the ability to invoke one own Action. */
type TriageDetailHostV1 = Readonly<{
  executeAction(
    action: string,
    input: JsonValue,
    options?: PluginCancellationOptions,
  ): Promise<unknown>;
}>;

type TriageEntryDetailTransportV1 = Readonly<{
  read(
    input: TriageReadEntryDetailInputV1,
    options?: PluginCancellationOptions,
  ): Promise<TriageReadEntryDetailResultV1>;
}>;

function createActionTriageEntryDetailTransport(
  host: TriageDetailHostV1,
): TriageEntryDetailTransportV1 {
  return Object.freeze({
    async read(input, options) {
      return TriageReadEntryDetailResultV1Schema.parse(await host.executeAction(
        TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
        input,
        options,
      ));
    },
  });
}

export type TriageEntryDetailInputSourceV1 = Readonly<{
  selection: Pick<TriageSurfaceSelectionV1, 'entryRef' | 'sourceInstanceId'>;
  /** The host-applied present observation for the selected entry and connection. */
  observation: TriageDetailSurfaceInputV1['observation'];
}>;

export async function readTriageEntryDetailState(
  host: TriageDetailHostV1,
  source: TriageEntryDetailInputSourceV1,
  options?: PluginCancellationOptions,
): Promise<TriageEntryDetailStateV1> {
  return await readTriageEntryDetailStateThrough(
    createActionTriageEntryDetailTransport(host),
    source,
    options,
  );
}

async function readTriageEntryDetailStateThrough(
  transport: TriageEntryDetailTransportV1,
  source: TriageEntryDetailInputSourceV1,
  options?: PluginCancellationOptions,
): Promise<TriageEntryDetailStateV1> {
  let result: TriageReadEntryDetailResultV1;
  try {
    result = await transport.read({
      v: 1,
      entryRef: source.selection.entryRef,
      sourceInstanceId: source.selection.sourceInstanceId,
    }, options);
  } catch {
    return UNREACHABLE;
  }
  // `invalidCaller` cannot be caused by anything the reader did and cannot be
  // resolved by them either; it reads as the same unavailable detail rather
  // than as an accusation.
  if (result.kind !== 'read') return UNAVAILABLE;

  const built = buildTriageDetailSurfaceInputV1({
    selection: source.selection,
    instance: result.instance,
    observation: source.observation,
    linkedSessions: result.linkedSessions,
    linkedSessionsHasMore: result.linkedSessionsNextCursor !== undefined,
  });
  return built.kind === 'admitted'
    ? Object.freeze({
      kind: 'ready',
      input: built.input,
      linkedSessions: result.linkedSessions,
      ...(result.linkedSessionsNextCursor === undefined
        ? {}
        : { linkedSessionsNextCursor: result.linkedSessionsNextCursor }),
      linkedSessionsPageState: 'idle',
      loadMoreLinkedSessions: () => {},
    })
    : Object.freeze({ kind: 'refused', reason: built.reason });
}

/**
 * Read the selected entry's detail input, once per selection.
 *
 * `null` means nothing is selected, which is not a state the detail region
 * renders — it is the list's own full-width composition.
 */
export function useTriageEntryDetail(
  source: TriageEntryDetailInputSourceV1 | null,
): TriageMountedEntryDetailStateV1 | null {
  const hostApi = usePluginHostApi();
  const readiness = usePluginHostReadiness(Object.is(TRIAGE_DATA_ACTION_EXECUTION_V1.target, 'daemon'));
  const transport = useMemo<TriageEntryDetailTransportV1>(
    () => createActionTriageEntryDetailTransport(hostApi),
    [hostApi],
  );
  const [state, setState] = useState<TriageEntryDetailStateV1 | null>(null);
  const stateRef = useRef<TriageEntryDetailStateV1 | null>(null);
  // Reads settle out of order across a fast selection change; only the newest
  // one may publish, or a reader can end up looking at the entry they left.
  const generation = useRef(0);
  const linkedSessionsController = useRef<AbortController | null>(null);
  /** Cursors already spent by this selection's mount-local linked-session walk. */
  const spentLinkedSessionCursors = useRef(new Set<string>());
  const [retryGeneration, setRetryGeneration] = useState(0);
  const replaceLoadedLinkedSessionPages = useRef(false);
  const readPending = useRef(false);
  const refreshAfterRead = useRef(false);
  const readObservation = useRef<Readonly<{ observedAtMs: number; sourceUpdatedAtMs?: number }> | undefined>(undefined);

  const selectedEntryRef = source?.selection.entryRef;
  const retainedEntryRef = useRef(selectedEntryRef);
  if (selectedEntryRef === undefined || retainedEntryRef.current === undefined
    || !sameTriageEntryRefV1(retainedEntryRef.current, selectedEntryRef)) {
    retainedEntryRef.current = selectedEntryRef;
  }
  const entryRef = retainedEntryRef.current;
  const sourceInstanceId = source?.selection.sourceInstanceId;
  const observation = source?.observation;
  const currentObservation = useRef(observation);
  currentObservation.current = observation;
  const sourceUpdatedAtMs = observation?.sourceUpdatedAtMs;
  const observedAtMs = observation?.observedAtMs;

  const publish = useCallback((next: TriageEntryDetailStateV1 | null): void => {
    stateRef.current = next;
    setState(next);
  }, []);
  const retry = useCallback((): void => {
    if (readiness.pending || readiness.ready === false) return;
    replaceLoadedLinkedSessionPages.current = true;
    setRetryGeneration((generation) => generation + 1);
  }, [readiness.pending, readiness.ready]);

  const loadMoreLinkedSessions = useCallback((): void => {
    if (readiness.pending || readiness.ready === false) return;
    const currentState = stateRef.current;
    if (currentState?.kind !== 'ready'
      || currentState.linkedSessionsNextCursor === undefined
      || currentState.linkedSessionsPageState === 'loading'
      || entryRef === undefined
      || sourceInstanceId === undefined
      || observation === undefined) return;

    const currentGeneration = generation.current;
    const cursor = currentState.linkedSessionsNextCursor;
    spentLinkedSessionCursors.current.add(cursor);
    const controller = new AbortController();
    linkedSessionsController.current?.abort();
    linkedSessionsController.current = controller;
    publish(Object.freeze({ ...currentState, linkedSessionsPageState: 'loading' }));

    void (async () => {
      let result: ReturnType<typeof TriageReadEntryDetailResultV1Schema.parse>;
      try {
        result = await transport.read({
          v: 1,
          entryRef,
          sourceInstanceId,
          linkedSessionsCursor: cursor,
        }, { signal: controller.signal });
      } catch {
        if (controller.signal.aborted || currentGeneration !== generation.current) return;
        const retained = stateRef.current;
        if (retained?.kind === 'ready') {
          publish(Object.freeze({ ...retained, linkedSessionsPageState: 'failed' }));
        }
        return;
      }
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      if (result.kind !== 'read') {
        const retained = stateRef.current;
        if (retained?.kind === 'ready') {
          publish(Object.freeze({ ...retained, linkedSessionsPageState: 'failed' }));
        }
        return;
      }

      const admittedPage = buildTriageDetailSurfaceInputV1({
        selection: { entryRef, sourceInstanceId },
        instance: result.instance,
        observation,
        linkedSessions: result.linkedSessions,
        linkedSessionsHasMore: result.linkedSessionsNextCursor !== undefined,
      });
      if (admittedPage.kind !== 'admitted') {
        const retained = stateRef.current;
        if (retained?.kind === 'ready') {
          publish(Object.freeze({ ...retained, linkedSessionsPageState: 'failed' }));
        }
        return;
      }

      const retained = stateRef.current;
      if (retained?.kind !== 'ready') return;
      const seen = new Set(retained.linkedSessions.map((session) => session.sessionId));
      const appended = result.linkedSessions.filter((session) => !seen.has(session.sessionId));
      const accumulated = Object.freeze({
        ...retained,
        linkedSessions: Object.freeze([...retained.linkedSessions, ...appended]),
        linkedSessionsPageState: 'idle',
      });
      if (isSpentTriageLinkedSessionCursorV1(
        spentLinkedSessionCursors.current,
        result.linkedSessionsNextCursor,
      )) {
        // Keep every linked Session this page admitted, but do not republish an
        // cursor this mounted walk already spent as another available page.
        // This settles both A→A and longer A→B→A cycles. Retry asks the current
        // Account boundary again after it recovers; the set dies with this
        // selection and is neither durable custody nor a second paging owner.
        publish(Object.freeze({
          ...accumulated,
          linkedSessionsNextCursor: cursor,
          linkedSessionsPageState: 'failed',
        }));
        return;
      }
      if (result.linkedSessionsNextCursor === undefined) {
        const { linkedSessionsNextCursor: _completedCursor, ...completed } = accumulated;
        publish(Object.freeze(completed));
      } else {
        publish(Object.freeze({
          ...accumulated,
          linkedSessionsNextCursor: result.linkedSessionsNextCursor,
        }));
      }
    })();
  }, [entryRef, observation, publish, sourceInstanceId, transport, readiness.pending, readiness.ready]);

  useEffect(() => {
    readPending.current = false;
    refreshAfterRead.current = false;
    readObservation.current = observation;
    if (entryRef === undefined || sourceInstanceId === undefined || observation === undefined) {
      generation.current += 1;
      linkedSessionsController.current?.abort();
      publish(null);
      return undefined;
    }
    generation.current += 1;
    linkedSessionsController.current?.abort();
    spentLinkedSessionCursors.current.clear();
    const current = generation.current;
    const controller = new AbortController();
    const retained = stateRef.current;
    publish(
      retained?.kind === 'ready'
      && sameTriageEntryRefV1(retained.input.observation.entryRef, entryRef)
      && retained.input.instance.instance.sourceInstanceId === sourceInstanceId
        ? retained
        : READING
    );
    if (readiness.pending || readiness.ready === false) return () => controller.abort();
    readPending.current = true;
    void (async () => {
      const next = await readTriageEntryDetailStateThrough(
        transport,
        { selection: { entryRef, sourceInstanceId },
          // Observation is local presentation, not an Account read input.
          // Compose the latest one when this acquisition actually settles.
          get observation() { return currentObservation.current ?? observation; } },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || current !== generation.current) return;
      readPending.current = false;
      // Ordinary source refresh retains already-loaded pages. An explicit relationship reread
      // must replace them: appending old rows would resurrect the link the user just removed.
      if (next.kind === 'unreachable' && stateRef.current?.kind === 'ready') {
        publish(Object.freeze({ ...stateRef.current, linkedSessionsPageState: 'failed' }));
      } else {
        publish(replaceLoadedLinkedSessionPages.current
          ? next
          : keepLoadedLinkedSessionPagesV1(stateRef.current, next));
      }
      if (next.kind === 'ready') replaceLoadedLinkedSessionPages.current = false;
      if (refreshAfterRead.current) {
        refreshAfterRead.current = false;
        setRetryGeneration((generation) => generation + 1);
      }
    })();
    return () => {
      controller.abort();
      readPending.current = false;
      linkedSessionsController.current?.abort();
    };
  }, [entryRef, publish, retryGeneration, sourceInstanceId, transport, readiness.pending, readiness.ready, readiness.revision]);

  useEffect(() => {
    if (observation === undefined || readiness.pending || readiness.ready === false
      || (readObservation.current?.observedAtMs === observedAtMs
        && readObservation.current?.sourceUpdatedAtMs === sourceUpdatedAtMs)) return;
    // A fresh observation also admits same-id connection metadata refreshes.
    // Finish the current Account read before acquiring that newer projection.
    if (readPending.current) refreshAfterRead.current = true;
    else setRetryGeneration((generation) => generation + 1);
  }, [observedAtMs, sourceUpdatedAtMs, readiness.pending, readiness.ready]);

  return useMemo(() => {
    if (entryRef === undefined || sourceInstanceId === undefined || observation === undefined) return null;
    if (readiness.pending && state?.kind !== 'ready') return READING;
    if (state?.kind === 'ready') {
      if (!sameTriageEntryRefV1(state.input.observation.entryRef, entryRef)
        || state.input.instance.instance.sourceInstanceId !== sourceInstanceId) return READING;
      const built = buildTriageDetailSurfaceInputV1({
        selection: { entryRef, sourceInstanceId },
        instance: state.input.instance,
        observation,
        linkedSessions: state.input.linkedSessions,
        linkedSessionsHasMore: state.input.linkedSessionsHasMore,
      });
      return built.kind === 'admitted'
        ? Object.freeze({ ...state, input: built.input, loadMoreLinkedSessions, refreshLinkedSessions: retry })
        : Object.freeze({ kind: 'refused' as const, reason: built.reason });
    }
    return state?.kind === 'unreachable' ? Object.freeze({ ...state, retry }) : state;
  }, [entryRef, observation, sourceInstanceId, loadMoreLinkedSessions, retry, state, readiness.pending]);
}
