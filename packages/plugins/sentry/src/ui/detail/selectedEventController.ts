/**
 * The detail-instance selected-event controller (`SENTRY.md` §7.2a).
 *
 * One controller is mounted at the root of each live Sentry detail instance and owns the
 * selected occurrence, its one `sentry/read-event` demand, and the single allow-listed
 * projection that Overview, an explicitly revealed occurrence detail and Stack Trace all
 * render. It is component state — not a module global, a query cache, or a persisted
 * store — because the exact detail instance is the privacy boundary: an event body's
 * lifetime must end when the reader leaves the issue, not when a tab unmounts.
 *
 * The state machine is separated from the hook because that is where the risk is. Four
 * silent defects live here, and each is a reducer case with a test rather than a
 * behaviour hidden in an effect:
 *
 * 1. a read that settles after its selection was replaced, publishing one occurrence's
 *    trace under another occurrence's heading;
 * 2. a second in-flight request because three consumers each demanded the same
 *    projection;
 * 3. a body that survives the selection that justified reading it; and
 * 4. a controller that fetches at all without a consumer demand — the rule that keeps
 *    scan, occurrence paging, inactive tabs and hover from ever costing an event body.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useExecutePluginAction } from '@happier-dev/plugin-ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { SentryReadEventResultV1Schema } from '../../detail/detailContracts.js';
import type { SentryEventProjectionV1 } from '../../privacy/sentryEventProjection.js';
import { SENTRY_ACTION_IDS, SENTRY_PLUGIN_ID } from '../../sentryContracts.js';

/**
 * Which occurrence the detail instance is showing.
 *
 * `representative` maps to Sentry's own `recommended` selector. The word the provider
 * uses is kept here so no surface can label it "latest", which it is not.
 */
export type SentrySelectedOccurrenceV1 =
  | Readonly<{ kind: 'representative' }>
  | Readonly<{ kind: 'event'; eventId: string }>;

export type SentrySelectedEventReadV1 =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'success'; projection: SentryEventProjectionV1 }>
  | Readonly<{ kind: 'error'; failure: TriageSourceFailureV1 }>;

export type SentrySelectedEventStateV1 = Readonly<{
  selected: SentrySelectedOccurrenceV1;
  read: SentrySelectedEventReadV1;
  /** Identifies the request whose result this state will accept. */
  token: number;
}>;

export type SentrySelectedEventEventV1 =
  /** A different entry or instance: nothing here belongs to it. */
  | Readonly<{ kind: 'identityChanged' }>
  | Readonly<{ kind: 'selected'; occurrence: SentrySelectedOccurrenceV1 }>
  /** A mounted consumer needs the current selection's projection. */
  | Readonly<{ kind: 'demanded' }>
  /** The reader asked for this exact selection again. */
  | Readonly<{ kind: 'refreshRequested' }>
  | Readonly<{ kind: 'settled'; token: number; projection: SentryEventProjectionV1 }>
  | Readonly<{ kind: 'failed'; token: number; failure: TriageSourceFailureV1 }>;

const INITIAL: SentrySelectedEventStateV1 = Object.freeze({
  selected: Object.freeze({ kind: 'representative' as const }),
  read: Object.freeze({ kind: 'idle' as const }),
  token: 0,
});

export function sentrySelectedEventInitialState(): SentrySelectedEventStateV1 {
  return INITIAL;
}

function sameOccurrence(
  left: SentrySelectedOccurrenceV1,
  right: SentrySelectedOccurrenceV1,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind !== 'event' || left.eventId === (right as { eventId: string }).eventId;
}

export function sentrySelectedEventReducer(
  state: SentrySelectedEventStateV1,
  event: SentrySelectedEventEventV1,
): SentrySelectedEventStateV1 {
  switch (event.kind) {
    case 'identityChanged':
      return INITIAL;
    case 'selected': {
      // Re-activating the row the reader is already on must not discard a loaded
      // trace and pay for it again.
      if (sameOccurrence(state.selected, event.occurrence)) return state;
      // The former occurrence's Tier-B/C content stops existing here, before
      // anything can render it beside a heading naming a different event.
      return {
        selected: event.occurrence,
        read: { kind: 'idle' },
        token: state.token + 1,
      };
    }
    case 'demanded':
      // Only an idle selection starts a read. A settled success, a settled
      // failure and an in-flight request are all answers already.
      return state.read.kind === 'idle'
        ? { ...state, read: { kind: 'loading' }, token: state.token + 1 }
        : state;
    case 'refreshRequested':
      return { ...state, read: { kind: 'loading' }, token: state.token + 1 };
    case 'settled':
      return event.token === state.token
        ? { ...state, read: { kind: 'success', projection: event.projection } }
        : state;
    case 'failed':
      return event.token === state.token
        ? { ...state, read: { kind: 'error', failure: event.failure } }
        : state;
    default:
      return state;
  }
}

export type SentrySelectedEventControllerV1 = Readonly<{
  selected: SentrySelectedOccurrenceV1;
  read: SentrySelectedEventReadV1;
  /** Called by a mounted consumer that needs the projection. Idempotent per selection. */
  demand: () => void;
  select: (occurrence: SentrySelectedOccurrenceV1) => void;
  refresh: () => void;
}>;

const UNREADABLE_RESULT: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'sentry-detail-result-unreadable',
});

type ExecuteResult = Readonly<{ status: string; result?: unknown; code?: string }>;

function dispatchFailure(status: string, code: string): TriageSourceFailureV1 {
  return Object.freeze({
    class: status === 'error' ? 'transient' : 'unknown',
    code: status === 'idle' || status === 'pending' ? 'sentry-detail-read-not-dispatched' : code,
  });
}

function detailIdentity(input: TriageDetailSurfaceInputV1): string {
  const { entryRef } = input.observation;
  return [
    input.instance.instance.sourceInstanceId,
    entryRef.collisionScope,
    entryRef.entryId,
  ].join(' ');
}

/**
 * Drives the one selected-event read for one mounted detail instance.
 *
 * `RenderContext.signal` is the detail-instance lifetime: the host aborts it when the
 * surface is retired, and the hook aborts its own request whenever the selection or the
 * exact entry/instance changes. A late result can therefore reach neither this state nor
 * a panel, and no projection survives the detail instance that justified reading it.
 *
 * A tab switch is deliberately not in that list. Switching between Overview, Occurrences
 * and Stack Trace changes only panel-local presentation; aborting the shared read there
 * would make three consumers of one projection behave like three owners of three.
 */
export function useSentrySelectedEvent(
  input: TriageDetailSurfaceInputV1,
  signal: AbortSignal,
): SentrySelectedEventControllerV1 {
  const [state, dispatch] = useReducer(sentrySelectedEventReducer, INITIAL);
  const identity = detailIdentity(input);
  const action = useMemo(
    () => ({ pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.readEvent }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useMemo(() => {
    const { entryRef } = input.observation;
    return {
      kindId: entryRef.kindId,
      collisionScope: entryRef.collisionScope,
      entryId: entryRef.entryId,
    };
  }, [input.observation]);
  const { instance } = input;

  // Only a real change resets. Dispatching on the first run would discard the demand a
  // consumer's own effect already made: child effects run before the parent's, so the
  // detail would mount, be asked for an occurrence, and then forget it was asked.
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    dispatch({ kind: 'identityChanged' });
  }, [identity]);

  const loading = state.read.kind === 'loading';
  const { token, selected } = state;
  // `selected` is captured for the request and re-read by the effect only through the
  // token that authorized it, so a selection change cannot retarget a request already
  // in flight — it supersedes it.
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!loading) return undefined;
    const controller = new AbortController();
    pending.current = controller;
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', abort);

    void (async () => {
      const execution = await execute({
        v: 1,
        instance,
        localRef,
        selector: selected,
      }, { signal: controller.signal }) as ExecuteResult;
      if (controller.signal.aborted) return;
      if (execution.status !== 'success') {
        dispatch({
          kind: 'failed',
          token,
          failure: dispatchFailure(execution.status, execution.code ?? 'sentry-detail-read-failed'),
        });
        return;
      }
      const parsed = SentryReadEventResultV1Schema.safeParse(execution.result);
      if (!parsed.success) {
        dispatch({ kind: 'failed', token, failure: UNREADABLE_RESULT });
        return;
      }
      if (parsed.data.kind === 'unavailable') {
        dispatch({ kind: 'failed', token, failure: parsed.data.failure });
        return;
      }
      dispatch({ kind: 'settled', token, projection: parsed.data.projection });
    })();

    return () => {
      signal.removeEventListener('abort', abort);
      controller.abort();
      pending.current = null;
    };
  }, [execute, instance, loading, localRef, selected, signal, token]);

  const demand = useCallback(() => {
    dispatch({ kind: 'demanded' });
  }, []);
  const select = useCallback((occurrence: SentrySelectedOccurrenceV1) => {
    dispatch({ kind: 'selected', occurrence });
  }, []);
  const refresh = useCallback(() => {
    dispatch({ kind: 'refreshRequested' });
  }, []);

  return useMemo(
    () => ({ selected: state.selected, read: state.read, demand, select, refresh }),
    [demand, refresh, select, state.read, state.selected],
  );
}
