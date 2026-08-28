import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
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
import { readTriageEntryDetail } from '../../actions/readEntryDetail.js';
import type { CorpusCollectionsV1 } from '../../corpus/collections/bindCorpusCollections.js';
import type { TriageSurfaceSelectionV1 } from '../state/surface.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';
import { useTriageDurableAccount } from '../durable/accountDurableState.js';
import { buildTriageDetailSurfaceInputV1 } from './input.js';

/**
 * The selected entry's mounted detail input.
 *
 * Two of the three members the strict boundary requires are Account Collection
 * state. When the mounted Account data client is reachable this hook reads
 * those members through the canonical Collection-backed domain owner; when it
 * is not, the plugin's own Action remains the daemon transport. Neither path
 * reaches a provider. The third member, the applied observation, is already in
 * the reader's device-local projection and is passed in.
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
  /** The Account could not be read at all; retrying is the reader's move. */
  | Readonly<{ kind: 'unreachable' }>
  /**
   * The durable facts read cleanly and still could not compose an admissible
   * detail input — an over-bound Session projection, or an observation that no
   * longer names the selected entry. It is not a source failure and is never
   * reported as one.
   */
  | Readonly<{ kind: 'refused'; reason: 'entryMismatch' | 'instanceMismatch' | 'invalidContractValue' }>;

const READING: TriageEntryDetailStateV1 = Object.freeze({ kind: 'reading' });
const UNAVAILABLE: TriageEntryDetailStateV1 = Object.freeze({ kind: 'unavailable' });
const UNREACHABLE: TriageEntryDetailStateV1 = Object.freeze({ kind: 'unreachable' });

/** Settle any cursor this mounted walk already spent, including A→B→A. */
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

/**
 * Read the durable half of detail directly from the mounted Account authority.
 *
 * This is the same domain owner the daemon Action calls, over the same three
 * Collection handles and codecs. The UI does not execute a provider operation
 * and does not recreate Session storage: when the generic Session summary
 * service is unavailable in this realm, the link keeps its canonical
 * `sessionId` and omits only presentation metadata, exactly as
 * `readTriageEntryDetail` specifies for an unavailable summary boundary.
 */
function createDirectTriageEntryDetailTransport(
  collections: Pick<CorpusCollectionsV1, 'sourceInstances' | 'sessionLinks'>,
): TriageEntryDetailTransportV1 {
  return Object.freeze({
    async read(input, options) {
      return await readTriageEntryDetail(input, {
        sourceInstances: collections.sourceInstances,
        sessionLinks: collections.sessionLinks,
        readSessionSummary: async () => null,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
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
): TriageEntryDetailStateV1 | null {
  const hostApi = usePluginHostApi();
  const durable = useTriageDurableAccount();
  const transport = useMemo<TriageEntryDetailTransportV1>(
    () => durable.collections === null
      ? createActionTriageEntryDetailTransport(hostApi)
      : createDirectTriageEntryDetailTransport(durable.collections),
    [durable.collections, hostApi],
  );
  const [state, setState] = useState<TriageEntryDetailStateV1 | null>(null);
  const stateRef = useRef<TriageEntryDetailStateV1 | null>(null);
  // Reads settle out of order across a fast selection change; only the newest
  // one may publish, or a reader can end up looking at the entry they left.
  const generation = useRef(0);
  const linkedSessionsController = useRef<AbortController | null>(null);
  /** Cursors already spent by this selection's mount-local linked-session walk. */
  const spentLinkedSessionCursors = useRef(new Set<string>());

  const entryRef = source?.selection.entryRef;
  const sourceInstanceId = source?.selection.sourceInstanceId;
  const observation = source?.observation;

  const publish = useCallback((next: TriageEntryDetailStateV1 | null): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const loadMoreLinkedSessions = useCallback((): void => {
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
  }, [entryRef, observation, publish, sourceInstanceId, transport]);

  useEffect(() => {
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
    void (async () => {
      const next = await readTriageEntryDetailStateThrough(
        transport,
        { selection: { entryRef, sourceInstanceId }, observation },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || current !== generation.current) return;
      publish(next);
    })();
    return () => {
      controller.abort();
      linkedSessionsController.current?.abort();
    };
  }, [entryRef, observation, publish, sourceInstanceId, transport]);

  return useMemo(() => (
    state?.kind === 'ready'
      ? Object.freeze({ ...state, loadMoreLinkedSessions })
      : state
  ), [loadMoreLinkedSessions, state]);
}
