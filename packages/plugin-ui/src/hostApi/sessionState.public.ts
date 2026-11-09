import * as React from 'react';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';

import { usePluginHostApi, usePluginHostApiResourceActive } from './context.js';

/**
 * One mounted read of a Session's live state.
 *
 * - `loading`: the first read has not settled.
 * - `ready`: `state` is the current host snapshot.
 * - `missing`: the Session does not exist or this Account cannot access it.
 * - `unavailable`: the read failed; `retryable` preserves the host's recovery fact.
 * - `unsupported`: the mounted host does not advertise `readSession`.
 */
export type SessionStateReadV1<T = SessionStateV1> = Readonly<{
  status: 'loading' | 'ready' | 'missing' | 'unavailable' | 'unsupported';
  state: T | null;
  /** Present for a failed read; known absence is `missing`, not a failed read. */
  retryable?: boolean;
}>;

const LOADING: SessionStateReadV1<never> = Object.freeze({ status: 'loading', state: null });
const MISSING: SessionStateReadV1<never> = Object.freeze({ status: 'missing', state: null });
const UNAVAILABLE: SessionStateReadV1<never> = Object.freeze({ status: 'unavailable', state: null, retryable: true });
const NON_RETRYABLE: SessionStateReadV1<never> = Object.freeze({ status: 'unavailable', state: null, retryable: false });
const UNSUPPORTED: SessionStateReadV1<never> = Object.freeze({ status: 'unsupported', state: null });

export type SessionStatesReadV1<T = SessionStateV1> = Readonly<{
  sessions: ReadonlyMap<string, SessionStateReadV1<T>>;
  refresh(): void;
}>;

/**
 * Read and follow the live state of one Session — typically one linked to this
 * plugin's own entry — through the mounted host.
 *
 * The host's `readSession` stays the one snapshot authority: this hook reads
 * once, observes `watchSession` invalidations, and re-reads on each. It keeps
 * the last snapshot while a re-read is in flight, never polls, persists
 * nothing, and retires its watch on unmount or when `sessionId` changes. Host
 * inactivity pauses reads and watches while retaining the snapshot; resuming
 * activity re-reads it. Providers without an activity fact remain live. A host
 * that serves reads but not watches yields a truthful one-shot snapshot.
 */
export function useSessionState(sessionId: string | null): SessionStateReadV1 {
  const ids = React.useMemo(() => sessionId === null ? [] : [sessionId], [sessionId]);
  return useSessionStates(ids).sessions.get(sessionId ?? '') ?? MISSING;
}

/**
 * Read and follow a set of Sessions through the same mounted lifecycle as
 * `useSessionState`. Repeated ids share one read/watch; input order has no
 * meaning. This is a mount-local projection, with no polling or persistence.
 * An optional stable selector narrows the serializable facts this consumer
 * follows; changes outside that projection do not publish a new snapshot.
 */
export function useSessionStates(sessionIds: readonly string[]): SessionStatesReadV1;
export function useSessionStates<T>(
  sessionIds: readonly string[], options: Readonly<{ select(state: SessionStateV1): T }>,
): SessionStatesReadV1<T>;
export function useSessionStates<T>(
  sessionIds: readonly string[], options?: Readonly<{ select(state: SessionStateV1): T }>,
): SessionStatesReadV1<T | SessionStateV1> {
  const host = usePluginHostApi();
  const active = usePluginHostApiResourceActive();
  const methods = host.version().methods;
  const canRead = methods.includes('readSession');
  const canWatch = methods.includes('watchSession');
  const ids = Array.from(new Set(sessionIds)).sort();
  const sessionKey = JSON.stringify(ids);
  const select = options?.select;
  const [reads, setReads] = React.useState<ReadonlyMap<string, SessionStateReadV1<T | SessionStateV1>>>(() => new Map());
  const [demand, setDemand] = React.useState(0);
  const refresh = React.useCallback(() => setDemand((value) => value + 1), []);
  const previousHost = React.useRef(host);
  const previousSelect = React.useRef(select);

  React.useEffect(() => {
    let current = true;
    const cancellation = new AbortController();
    const subscriptions: Readonly<{ dispose(): void }>[] = [];
    const retain = previousHost.current === host && previousSelect.current === select;
    previousHost.current = host;
    previousSelect.current = select;
    const snapshots = new Map(ids.map((id) => [id, !canRead ? UNSUPPORTED
      : retain && reads.get(id)?.status === 'ready' ? reads.get(id)! : LOADING]));
    setReads((previous) => (sameSessionReads(previous, snapshots) ? previous : new Map(snapshots)));
    if (!active) return;
    const publish = (sessionId: string, read: SessionStateReadV1<T | SessionStateV1>): void => {
      if (!current) return;
      // A watch invalidates on any Session change, including fields no consumer reads; an equal re-read keeps
      // the snapshot every consumer already holds rather than handing them a new map to recompute from.
      const previous = snapshots.get(sessionId);
      if (previous !== undefined && sameSessionRead(previous, read)) return;
      snapshots.set(sessionId, read);
      setReads(new Map(snapshots));
    };
    if (canRead) for (const sessionId of ids) {
      const refresh = async (): Promise<void> => {
        if (!current) return;
        try {
          const state = await host.readSession(sessionId, { signal: cancellation.signal });
          publish(sessionId, state ? Object.freeze({ status: 'ready', state: select === undefined ? state : select(state) }) : MISSING);
        } catch (error) {
          publish(sessionId, isPluginError(error) && !error.retryable ? NON_RETRYABLE : UNAVAILABLE);
        }
      };
      void (async () => {
        if (canWatch) {
          try {
            const established = await host.watchSession(sessionId, () => {
              if (!current) return;
              // A terminated watch establishes no snapshot fact. Read once to distinguish
              // terminal absence from a failed read, without reopening the watch or polling.
              void refresh();
            }, { signal: cancellation.signal });
            if (!current) {
              established.dispose();
              return;
            }
            subscriptions.push(established);
          } catch {
            // An unreachable Session refuses its watch; the read below reports it.
          }
        }
        await refresh();
      })();
    }

    return () => {
      current = false;
      cancellation.abort();
      for (const subscription of subscriptions) subscription.dispose();
    };
    // The key encodes the deduplicated set, so equivalent input arrays do not
    // retire and recreate the host subscriptions.
  }, [active, canRead, canWatch, demand, host, select, sessionKey]);

  const sessions = React.useMemo(() => new Map(ids.map((id) => [
    id, reads.get(id) ?? (canRead ? LOADING : UNSUPPORTED),
  ])), [canRead, reads, sessionKey]);
  return React.useMemo(() => ({ sessions, refresh }), [refresh, sessions]);
}

/**
 * Whether two reads say the same thing. A Session state is the host's plain serializable projection, produced
 * by one serializer per host, so its serialization is a faithful and cheap equality for it.
 */
function sameSessionRead<T>(left: SessionStateReadV1<T>, right: SessionStateReadV1<T>): boolean {
  if (left === right) return true;
  if (left.status !== right.status) return false;
  if (left.retryable !== right.retryable) return false;
  if (left.state === right.state) return true;
  return left.state !== null && right.state !== null && JSON.stringify(left.state) === JSON.stringify(right.state);
}

function sameSessionReads<T>(
  left: ReadonlyMap<string, SessionStateReadV1<T>>,
  right: ReadonlyMap<string, SessionStateReadV1<T>>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, read] of right) {
    const previous = left.get(id);
    if (previous === undefined || !sameSessionRead(previous, read)) return false;
  }
  return true;
}
