import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';

import type { TriageListLoadMoreV1 } from '../../projection/listWindowStore.js';
import type { TriageListDisplayRowV1 } from './pinnedRows.js';
import { useTriageDurableAccount } from '../durable/accountDurableState.js';
import {
  createActionTriageMarksTransport,
  createDirectTriageMarksTransport,
  type TriageMarksTransportV1,
  type TriagePinIntentV1,
  type TriagePinnedEntryV1,
} from './pinCommand.js';

/**
 * The reader's pins, as this mount knows them.
 *
 * It holds the authoritative answer and nothing else. There is no local pinned
 * set, no optimistic flip and no offline queue: a Pin the surface displayed but
 * never wrote would be intent the user believes is safe and that no provider,
 * device or refresh can hand back. So a row becomes pinned when the write has
 * settled and the marks read has changed, and not one render before.
 *
 * A conflict is a settled answer rather than a failure — another writer won, so
 * this mount re-reads instead of forcing its own intent. A rejected call means
 * the Account store could not be reached at all, which disables Pin/Unpin with
 * a stated reason rather than leaving a control that silently does nothing.
 *
 * A reader with more pins than one bounded page holds can reach the rest, and
 * the shape is deliberately the mounted window's: one integer for how many
 * pages this mount asked for, no persisted cursor, no accumulated set outliving
 * the mount, and a re-read that walks the depth already asked for instead of
 * restarting at the newest page and discarding what the reader had loaded.
 */

export type TriagePinNoticeV1 = Readonly<{
  tone: 'success' | 'warning';
  message: string;
}>;

export type TriageMountedPinsV1 = Readonly<{
  /** Newest pin first, exactly as the marks query returned them. */
  pins: readonly TriagePinnedEntryV1[];
  /** Whether the reader has more pins than these pages hold. */
  more: boolean;
  /**
   * What pressing the Pinned section's continuation row would do, in the same
   * vocabulary the mounted window publishes for its own sections.
   *
   * `atCeiling` is unreachable here and that is a product decision, not an
   * omission: every pin is the reader's own durable intent, so there is no
   * depth past which this mount may stop offering to reach one.
   */
  loadMore: TriageListLoadMoreV1;
  /** Explicit user demand for the pins after the pages already loaded. */
  loadMorePins: () => void;
  /** The row whose write has not settled, by list key. */
  busyKey: string | null;
  /** Why Pin/Unpin is unavailable, in words, or `null` when it works. */
  unavailableReason: string | null;
  /** One restrained confirmation of the last settled write. */
  notice: TriagePinNoticeV1 | null;
  setPinned: (row: TriageListDisplayRowV1) => void;
}>;

const UNAVAILABLE_REASON = 'Happier cannot reach your account right now, so pins cannot be changed.';

/**
 * One demand for this mount's pins: how many bounded pages to walk, whether the
 * reader asked for the deeper one, and which demand this is.
 *
 * `nonce` is what makes a retry a demand at all — a retry asks for the same
 * depth, so without it the read would never be re-run.
 */
type TriagePinsDemandV1 = Readonly<{ pages: number; appending: boolean; nonce: number }>;

const FIRST_PAGE_V1: TriagePinsDemandV1 = Object.freeze({ pages: 1, appending: false, nonce: 0 });

/** Pin names what it pinned; Unpin names only the entry. */
function intentFor(row: TriageListDisplayRowV1): TriagePinIntentV1 {
  return row.pinned
    ? { pinned: false, entryRef: row.entryRef }
    : {
        pinned: true,
        entryRef: row.entryRef,
        // Copied from the projection this row was rendered from, so the mark
        // names exactly what the reader saw when they pressed Pin.
        displayAtMark: { title: row.title, scopeLabel: row.scopeLabel },
      };
}

function noticeFor(
  status: 'pinned' | 'unpinned' | 'conflict',
  text: (key: string, fallback?: string) => string,
): TriagePinNoticeV1 {
  if (status === 'conflict') {
    return {
      tone: 'warning',
      message: text(
        'plugins.triage.surface.pin.conflict',
        'That pin was changed somewhere else. Showing the current state.',
      ),
    };
  }
  return {
    tone: 'success',
    message: status === 'pinned'
      ? text('plugins.triage.surface.pin.pinned', 'Pinned')
      : text('plugins.triage.surface.pin.unpinned', 'Unpinned'),
  };
}

export function useTriagePinnedEntries(): TriageMountedPinsV1 {
  const hostApi = usePluginHostApi();
  const durable = useTriageDurableAccount();
  const text = usePluginTranslation();
  // One owner, two transports. Direct Account Collections when this mount can
  // reach the Account — which is what keeps Pin working while no daemon is —
  // and the published Actions otherwise. The state machine below never learns
  // which one it got.
  const transport = useMemo<TriageMarksTransportV1>(
    () => durable.collections
      ? createDirectTriageMarksTransport(durable.collections)
      : createActionTriageMarksTransport(hostApi),
    [durable.collections, hostApi],
  );
  const [pins, setPins] = useState<readonly TriagePinnedEntryV1[]>([]);
  const [more, setMore] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [notice, setNotice] = useState<TriagePinNoticeV1 | null>(null);
  const [demand, setDemand] = useState<TriagePinsDemandV1>(FIRST_PAGE_V1);
  /** Whether a read is running; the demand says whether it is an append. */
  const [reading, setReading] = useState(false);
  /** Whether the last append ended without delivering the page it asked for. */
  const [appendFailed, setAppendFailed] = useState(false);
  const generation = useRef(0);

  /**
   * Walk this mount's pages from the newest one, in order.
   *
   * The cursor exists only inside this walk: it is read from the page that
   * produced it and handed to the next, and it is gone when the function
   * returns. Nothing is checkpointed, so a lost mount starts at the newest page.
   *
   * A page that fails keeps every page that answered. That is the same rule the
   * window store's passes follow and for the same reason — an unanswered page
   * says nothing about the ones that answered — and it is what leaves the pins
   * already on screen untouched by an append that could not be delivered.
   */
  const read = useCallback(async (
    signal: AbortSignal,
    request: TriagePinsDemandV1,
  ): Promise<void> => {
    generation.current += 1;
    const current = generation.current;
    /** Reads settle out of order; only the newest one may publish. */
    const superseded = (): boolean => signal.aborted || current !== generation.current;
    setReading(true);
    const collected: TriagePinnedEntryV1[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < request.pages; page += 1) {
      try {
        const answered = await transport.read(cursor, { signal });
        if (superseded()) return;
        collected.push(...answered.pins);
        cursor = answered.nextCursor;
      } catch {
        if (superseded()) return;
        if (page === 0) {
          // Nothing was read at all. The retained pins stay on screen: they are
          // the last thing the Account actually said, and blanking them would
          // read as "you pinned nothing".
          setUnavailableReason(text('plugins.triage.surface.pin.unavailable', UNAVAILABLE_REASON));
        } else {
          // The store answered the earlier pages, so it is reachable; only this
          // page is missing. The pins it did carry stay, and the section keeps
          // its continuation row because a cursor we failed to follow is still
          // a cursor.
          setPins(Object.freeze(collected));
          setMore(true);
          setUnavailableReason(null);
        }
        setAppendFailed(request.appending);
        setReading(false);
        return;
      }
      if (cursor === undefined) break;
    }
    setPins(Object.freeze(collected));
    setMore(cursor !== undefined);
    setUnavailableReason(null);
    setAppendFailed(false);
    setReading(false);
  }, [text, transport]);

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal, demand);
    return () => { controller.abort(); };
  }, [demand, read]);

  const loadMorePins = useCallback((): void => {
    if (reading) return;
    setDemand((current) => ({
      // A failed append retries the depth it already asked for. Deepening here
      // would step past a page this mount never received.
      pages: appendFailed ? current.pages : current.pages + 1,
      appending: true,
      nonce: current.nonce + 1,
    }));
  }, [appendFailed, reading]);

  const setPinned = useCallback((row: TriageListDisplayRowV1): void => {
    if (busyKey !== null || unavailableReason !== null) return;
    const controller = new AbortController();
    setBusyKey(row.key);
    setNotice(null);
    void (async () => {
      try {
        const result = await transport.write(intentFor(row), { signal: controller.signal });
        setNotice(noticeFor(result.status, text));
        // Re-read at the depth the reader has already loaded, not the newest
        // page alone: unpinning from a deeper page must not fold the section
        // back to its first one.
        await read(controller.signal, { ...demand, appending: false });
      } catch {
        setUnavailableReason(text('plugins.triage.surface.pin.unavailable', UNAVAILABLE_REASON));
      } finally {
        setBusyKey(null);
      }
    })();
  }, [busyKey, demand, read, text, transport, unavailableReason]);

  /**
   * The same override order the window store publishes: a running read outranks
   * everything, a failed append outranks the exhaustion claim, and only then
   * does the cursor decide.
   *
   * The first arm reads `reading` alone, exactly as `loadMorePins` above does.
   * Narrowing it to `reading && demand.appending` made the published arm and
   * the gate disagree: during any NON-append read — the one a pin or unpin
   * re-issues at the reader's current depth — a cursor that still had more
   * published `available` while the callback refused the press, so the reader
   * pressed and nothing happened, with no loading state, no failure and no
   * retry offer. The window store states the invariant next door and holds to
   * it: a row can never offer a press its owner refuses.
   */
  const loadMore = useMemo<TriageListLoadMoreV1>(() => {
    if (reading) return Object.freeze({ kind: 'loading' });
    if (appendFailed) return Object.freeze({ kind: 'failed' });
    return more ? Object.freeze({ kind: 'available' }) : Object.freeze({ kind: 'exhausted' });
  }, [appendFailed, more, reading]);

  return useMemo(() => Object.freeze({
    pins,
    more,
    loadMore,
    loadMorePins,
    busyKey,
    unavailableReason,
    notice,
    setPinned,
  }), [busyKey, loadMore, loadMorePins, more, notice, pins, setPinned, unavailableReason]);
}
