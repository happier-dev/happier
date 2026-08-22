import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';

import type { TriageListDisplayRowV1 } from './pinnedRows.js';
import {
  readTriagePinnedEntries,
  submitTriagePin,
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
 */

export type TriagePinNoticeV1 = Readonly<{
  tone: 'success' | 'warning';
  message: string;
}>;

export type TriageMountedPinsV1 = Readonly<{
  /** Newest pin first, exactly as the marks query returned them. */
  pins: readonly TriagePinnedEntryV1[];
  /** Whether the reader has more pins than this bounded page holds. */
  more: boolean;
  /** The row whose write has not settled, by list key. */
  busyKey: string | null;
  /** Why Pin/Unpin is unavailable, in words, or `null` when it works. */
  unavailableReason: string | null;
  /** One restrained confirmation of the last settled write. */
  notice: TriagePinNoticeV1 | null;
  setPinned: (row: TriageListDisplayRowV1) => void;
}>;

const UNAVAILABLE_REASON = 'Happier cannot reach your account right now, so pins cannot be changed.';

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
  const text = usePluginTranslation();
  const [pins, setPins] = useState<readonly TriagePinnedEntryV1[]>([]);
  const [more, setMore] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [notice, setNotice] = useState<TriagePinNoticeV1 | null>(null);
  // Reads are cheap and settle out of order; only the newest one may publish.
  const generation = useRef(0);

  const read = useCallback(async (signal: AbortSignal): Promise<void> => {
    generation.current += 1;
    const current = generation.current;
    try {
      const page = await readTriagePinnedEntries(hostApi, { signal });
      if (signal.aborted || current !== generation.current) return;
      setPins(page.pins);
      setMore(page.more);
      setUnavailableReason(null);
    } catch {
      if (signal.aborted || current !== generation.current) return;
      // The retained pins stay on screen: they are the last thing the Account
      // actually said, and blanking them would read as "you pinned nothing".
      setUnavailableReason(text('plugins.triage.surface.pin.unavailable', UNAVAILABLE_REASON));
    }
  }, [hostApi, text]);

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => { controller.abort(); };
  }, [read]);

  const setPinned = useCallback((row: TriageListDisplayRowV1): void => {
    if (busyKey !== null || unavailableReason !== null) return;
    const controller = new AbortController();
    setBusyKey(row.key);
    setNotice(null);
    void (async () => {
      try {
        const result = await submitTriagePin(hostApi, intentFor(row), { signal: controller.signal });
        setNotice(noticeFor(result.status, text));
        await read(controller.signal);
      } catch {
        setUnavailableReason(text('plugins.triage.surface.pin.unavailable', UNAVAILABLE_REASON));
      } finally {
        setBusyKey(null);
      }
    })();
  }, [busyKey, hostApi, read, text, unavailableReason]);

  return useMemo(() => Object.freeze({
    pins,
    more,
    busyKey,
    unavailableReason,
    notice,
    setPinned,
  }), [busyKey, more, notice, pins, setPinned, unavailableReason]);
}
