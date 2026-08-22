import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';

import type { TriageAdministerSavedViewInputV1 } from '../../actions/savedViewsProtocol.js';
import type { CorpusSavedViewsReadV1 } from '../../settings/savedViews.js';
import {
  administerTriageSavedViewFromSurface,
  readTriageSavedViewsFromSurface,
  readTriageSavedViewsProjectionV1,
} from './savedViewsCommand.js';

/**
 * The reader's saved views, as this mount knows them.
 *
 * It holds the authoritative answer and nothing else. There is no local view
 * set, no optimistic create and no queue: a view the surface showed but never
 * wrote would be durable user policy the reader believes is safe and that no
 * device or reload can hand back. So the set changes when the write has settled
 * and the authoritative projection has come back, and not one render before.
 *
 * `saved` is `null` until the first read answers. That is a third state rather
 * than an empty set on purpose — a location carrying a selected view id must
 * not have it cleared as "unknown" merely because the read has not landed yet.
 *
 * A conflict is a settled answer rather than a failure: another writer won, so
 * this mount keeps the projection it is showing, says that nothing here changed,
 * and re-reads at the same owner so the next attempt starts from the truth. A
 * rejected read means the Account could not be reached at all, which disables
 * the view controls with a stated reason rather than leaving controls that
 * silently do nothing.
 */

export type TriageSavedViewsNoticeV1 = Readonly<{
  tone: 'success' | 'warning';
  message: string;
}>;

export type TriageMountedSavedViewsV1 = Readonly<{
  /** The authoritative durable set, or `null` while the first read is in flight. */
  saved: CorpusSavedViewsReadV1 | null;
  /** A write this mount asked for has not settled. */
  busy: boolean;
  /** One restrained settlement message for the last write. */
  notice: TriageSavedViewsNoticeV1 | null;
  /** Why views cannot be changed right now, in words, or `null` when they can. */
  unavailableReason: string | null;
  /**
   * Run one explicit create/rename/update/delete/select.
   *
   * It resolves to the authoritative projection when the owner applied the
   * write, and to `null` for every settled refusal — so a caller can make the
   * applied projection its lens without ever guessing at one.
   */
  administer(input: TriageAdministerSavedViewInputV1): Promise<CorpusSavedViewsReadV1 | null>;
}>;

const UNAVAILABLE_REASON = 'Happier cannot reach your account right now, so saved views cannot be changed.';

export function useTriageSavedViews(): TriageMountedSavedViewsV1 {
  const hostApi = usePluginHostApi();
  const text = usePluginTranslation();
  const [saved, setSaved] = useState<CorpusSavedViewsReadV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<TriageSavedViewsNoticeV1 | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  // Reads settle out of order; only the newest one may publish.
  const generation = useRef(0);

  const read = useCallback(async (signal: AbortSignal): Promise<void> => {
    generation.current += 1;
    const current = generation.current;
    try {
      const projection = await readTriageSavedViewsFromSurface(hostApi, { signal });
      if (signal.aborted || current !== generation.current) return;
      setSaved(readTriageSavedViewsProjectionV1(projection));
      setUnavailableReason(null);
    } catch {
      if (signal.aborted || current !== generation.current) return;
      // The retained set stays on screen: it is the last thing the Account
      // actually said, and blanking it would read as "you saved no views".
      setUnavailableReason(text('plugins.triage.surface.views.unavailable', UNAVAILABLE_REASON));
    }
  }, [hostApi, text]);

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => { controller.abort(); };
  }, [read]);

  const administer = useCallback(async (
    input: TriageAdministerSavedViewInputV1,
  ): Promise<CorpusSavedViewsReadV1 | null> => {
    if (busy || unavailableReason !== null) return null;
    const controller = new AbortController();
    setBusy(true);
    setNotice(null);
    try {
      const result = await administerTriageSavedViewFromSurface(hostApi, input, {
        signal: controller.signal,
      });
      if (result.status === 'applied') {
        const projection = readTriageSavedViewsProjectionV1({
          availability: 'parsed',
          views: result.views ?? [],
          selectedViewId: result.selectedViewId ?? null,
        });
        setSaved(projection);
        setNotice({
          tone: 'success',
          message: text('plugins.triage.surface.views.settled', 'Saved views updated'),
        });
        return projection;
      }
      setNotice({ tone: 'warning', message: refusalMessage(result, text) });
      // A conflict and an unknown view are the two refusals that mean the set
      // itself moved under this mount, so it re-reads at that same owner and
      // the reader retries against the truth. Nothing here applies the losing
      // write or blanks what is on screen. A rejected bound moved nothing, so
      // re-reading it would be churn that says the set changed when it did not.
      if (result.status === 'conflict' || result.status === 'unknownView') {
        await read(controller.signal);
      }
      return null;
    } catch {
      setUnavailableReason(text('plugins.triage.surface.views.unavailable', UNAVAILABLE_REASON));
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, hostApi, read, text, unavailableReason]);

  return useMemo(() => Object.freeze({
    saved,
    busy,
    notice,
    unavailableReason,
    administer,
  }), [administer, busy, notice, saved, unavailableReason]);
}

/**
 * Name the refusal in the reader's own terms.
 *
 * The three reachable refusals from this control are named individually because
 * the next action differs for each. Every other bound the one CAS owner
 * enforces is unreachable from a lens the reducer already validated with the
 * same constants, so they share one honest sentence rather than nine
 * translations of a state nothing can produce.
 */
function refusalMessage(
  result: Readonly<{ status: string; reason?: string }>,
  text: (key: string, fallback?: string) => string,
): string {
  if (result.status === 'conflict') {
    return text(
      'plugins.triage.surface.views.conflict',
      'Your saved views changed somewhere else, so nothing was changed here. Try again.',
    );
  }
  if (result.status === 'unknownView') {
    return text(
      'plugins.triage.surface.views.unknown',
      'That view no longer exists. Showing the views you have now.',
    );
  }
  if (result.status === 'unreadable') {
    return text(
      'plugins.triage.surface.views.unreadable',
      'These saved views were written by a newer version of Happier, so they were left untouched.',
    );
  }
  if (result.reason === 'label') {
    return text('plugins.triage.surface.views.rejected.label', 'That name is empty or too long.');
  }
  if (result.reason === 'viewLimit') {
    return text(
      'plugins.triage.surface.views.rejected.viewLimit',
      'You already have as many saved views as Happier keeps. Delete one to save another.',
    );
  }
  if (result.reason === 'valueTooLarge') {
    return text(
      'plugins.triage.surface.views.rejected.tooLarge',
      'Your saved views are as large as Happier keeps them. Delete one to save another.',
    );
  }
  return text('plugins.triage.surface.views.rejected.other', 'That view could not be saved, so nothing was changed.');
}
