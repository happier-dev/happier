import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';

import type { TriageAdministerActionInputV1 } from '../../actions/actionsCatalogProtocol.js';
import type { TriageActionV1, TriageActionsReadV1 } from '../../settings/actions.js';
import { useTriageDurableAccount } from '../durable/accountDurableState.js';
import {
  TRIAGE_UNREAD_ACTIONS_V1,
  createActionTriageActionsTransport,
  createDirectTriageActionsTransport,
  readTriageActionsProjectionV1,
  type TriageActionsTransportV1,
} from './actionsCommand.js';

/**
 * The configured action catalog, as this mount knows it.
 *
 * It holds the authoritative answer and nothing else. There is no local
 * catalog, no optimistic create and no queue: an action the surface showed but
 * never wrote would be durable configuration the person believes is safe and
 * that no device or reload can hand back. So the set changes when the write has
 * settled and the authoritative projection has come back, and not one render
 * before.
 *
 * `read` is the shipped seed until the first read answers, which is a claim the
 * owner already makes about absence — not an empty list, which would render a
 * detail pane with no controls and read as "you configured none".
 *
 * A conflict is a settled answer rather than a failure: another writer won, so
 * this mount keeps what it is showing, says nothing here changed, and re-reads
 * at the same owner so the next attempt starts from the truth.
 */

export type TriageActionsNoticeV1 = Readonly<{
  tone: 'success' | 'warning';
  message: string;
}>;

export type TriageMountedActionsV1 = Readonly<{
  /** The authoritative catalog, or the seed while the first read is in flight. */
  read: TriageActionsReadV1;
  /**
   * The revision the catalog on screen was read at, or `null` before the first
   * read answered.
   *
   * `null` is not "any revision": it is "this mount has never seen the
   * Account's catalog", and a write formed against the seed it is showing
   * instead would be a write against a set nobody read. Every command carries
   * this value, so a change made anywhere else between the read and the press
   * is refused rather than overwritten.
   */
  revision: string | null;
  /** The offered order, which is the stored order. */
  actions: readonly TriageActionV1[];
  /** The first read has answered, so the set on screen is the Account's. */
  loaded: boolean;
  /** A write this mount asked for has not settled. */
  busy: boolean;
  /** One restrained settlement message for the last write. */
  notice: TriageActionsNoticeV1 | null;
  /** Why actions cannot be changed right now, in words, or `null` when they can. */
  unavailableReason: string | null;
  /**
   * Run one explicit create/update/delete/reorder.
   *
   * It resolves to the authoritative catalog when the owner applied the write,
   * and to `null` for every settled refusal — so a caller never has to guess at
   * the set a refusal left behind.
   */
  administer(input: TriageAdministerActionInputV1): Promise<readonly TriageActionV1[] | null>;
}>;

const UNAVAILABLE_REASON =
  'Happier cannot reach your account right now, so actions cannot be changed.';

export function useTriageActions(): TriageMountedActionsV1 {
  const hostApi = usePluginHostApi();
  const durable = useTriageDurableAccount();
  const text = usePluginTranslation();
  // One owner, two transports. Direct Account Settings when this mount can
  // reach the Account — which is what keeps the configured actions readable and
  // editable while no daemon is — and the published Actions otherwise.
  const transport = useMemo<TriageActionsTransportV1>(
    () => durable.settings
      ? createDirectTriageActionsTransport(durable.settings)
      : createActionTriageActionsTransport(hostApi),
    [durable.settings, hostApi],
  );
  const [read, setRead] = useState<TriageActionsReadV1>(TRIAGE_UNREAD_ACTIONS_V1);
  const [revision, setRevision] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<TriageActionsNoticeV1 | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  // Reads settle out of order; only the newest one may publish.
  const generation = useRef(0);

  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    generation.current += 1;
    const current = generation.current;
    try {
      const projection = await transport.read({ signal });
      if (signal.aborted || current !== generation.current) return;
      setRead(readTriageActionsProjectionV1(projection));
      setRevision(projection.revision);
      setLoaded(true);
      setUnavailableReason(null);
    } catch {
      if (signal.aborted || current !== generation.current) return;
      // The retained catalog stays on screen: blanking it would take every
      // control off a detail pane because one read did not answer.
      setUnavailableReason(text('plugins.triage.surface.actions.unavailable', UNAVAILABLE_REASON));
    }
  }, [text, transport]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => { controller.abort(); };
  }, [load]);

  const administer = useCallback(async (
    input: TriageAdministerActionInputV1,
  ): Promise<readonly TriageActionV1[] | null> => {
    if (busy || unavailableReason !== null) return null;
    const controller = new AbortController();
    setBusy(true);
    setNotice(null);
    try {
      const result = await transport.administer(input, { signal: controller.signal });
      if (result.status === 'applied') {
        const projection = readTriageActionsProjectionV1({
          availability: 'parsed',
          actions: result.actions ?? [],
        });
        setRead(projection);
        // The revision the applied value now sits at. Retaining the spent one
        // would make the next press conflict with this mount's own write.
        if (result.revision !== undefined) setRevision(result.revision);
        setLoaded(true);
        setNotice({
          tone: 'success',
          message: text('plugins.triage.surface.actions.settled', 'Actions updated'),
        });
        return projection.value.actions;
      }
      setNotice({ tone: 'warning', message: refusalMessage(result, text) });
      // A conflict and an unknown action are the two refusals that mean the set
      // itself moved under this mount, so it re-reads at that same owner and the
      // person retries against the truth. A rejected bound moved nothing, so
      // re-reading it would say the set changed when it did not.
      if (result.status === 'conflict' || result.status === 'unknownAction') {
        await load(controller.signal);
      }
      return null;
    } catch {
      setUnavailableReason(text('plugins.triage.surface.actions.unavailable', UNAVAILABLE_REASON));
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, load, text, transport, unavailableReason]);

  return useMemo(() => Object.freeze({
    read,
    revision,
    actions: read.value.actions,
    loaded,
    busy,
    notice,
    unavailableReason,
    administer,
  }), [administer, busy, loaded, notice, read, revision, unavailableReason]);
}

/**
 * Name the refusal in the person's own terms.
 *
 * The refusals a person can actually cause from this editor are named
 * individually because the next step differs for each. The remaining bounds the
 * one CAS owner enforces are unreachable from a draft the editor's own controls
 * already constrain to the same closed vocabularies, so they share one honest
 * sentence rather than thirteen translations of a state nothing can produce.
 */
function refusalMessage(
  result: Readonly<{ status: string; reason?: string }>,
  text: (key: string, fallback?: string) => string,
): string {
  if (result.status === 'conflict') {
    return text(
      'plugins.triage.surface.actions.conflict',
      'Your actions changed somewhere else, so nothing was changed here. Try again.',
    );
  }
  if (result.status === 'unknownAction') {
    return text(
      'plugins.triage.surface.actions.unknown',
      'That action no longer exists. Showing the actions you have now.',
    );
  }
  if (result.status === 'unreadable') {
    return text(
      'plugins.triage.surface.actions.unreadable',
      'These actions were written by a newer version of Happier, so they were left untouched.',
    );
  }
  if (result.reason === 'label') {
    return text('plugins.triage.surface.actions.rejected.label', 'That name is empty or too long.');
  }
  if (result.reason === 'appliesTo' || result.reason === 'duplicateSubject') {
    return text(
      'plugins.triage.surface.actions.rejected.appliesTo',
      'Choose at least one kind of entry for this action, and each one only once.',
    );
  }
  if (result.reason === 'valueTooLarge') {
    return text(
      'plugins.triage.surface.actions.rejected.other',
      'That action could not be saved, so nothing was changed.',
    );
  }
  return text(
    'plugins.triage.surface.actions.rejected.other',
    'That action could not be saved, so nothing was changed.',
  );
}
