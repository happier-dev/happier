import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSessionStates } from '@happier-dev/plugin-ui';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { triageEntryRowKey } from '../../projection/listWindow.js';
import { readTriageSessionLinksPageV1 } from '../../sessions/readEntrySessionLinks.js';
import { useTriageDurableAccount } from '../durable/accountDurableState.js';

type LinksByEntry = ReadonlyMap<string, readonly string[]>;
type LinkRead = Readonly<{ links: LinksByEntry; status: 'reading' | 'ready' | 'unavailable' }>;

const INITIAL: LinkRead = Object.freeze({ links: new Map(), status: 'reading' });

/**
 * One mounted list join: the existing Session-link index supplies relationships,
 * and the host's shared Session hook supplies current Work facts. Acquisition is
 * paged once for the window, never placed on each row. Links outside the window
 * are discarded as each page arrives; no Account corpus or durable mirror is made.
 */
export function useTriageListSessionActivityV1(input: Readonly<{
  entryRefs: readonly TriageEntryRefV1[];
  /** Moves once per list pass that read (`TriageListWindowSnapshotV1.passes`); each move re-reads the links once. */
  acquisition: unknown;
  active: boolean;
}>): Readonly<{
  /** The live states of each listed entry's linked Sessions that have answered, by row key. */
  agentStates: ReadonlyMap<string, readonly SessionStateV1[]>;
  incomplete: boolean;
  unavailable: boolean;
  retry(): void;
}> {
  const { collections } = useTriageDurableAccount();
  const keys = input.entryRefs.map(triageEntryRowKey).sort();
  const keysIdentity = JSON.stringify(keys);
  const [read, setRead] = useState<LinkRead>(INITIAL);
  const [demand, setDemand] = useState(0);

  useEffect(() => {
    if (!input.active) return;
    if (keys.length === 0) {
      setRead((previous) => (previous.status === 'ready' && previous.links.size === 0
        ? previous
        : { links: new Map(), status: 'ready' }));
      return;
    }
    if (collections === null) {
      setRead((previous) => (previous.status === 'unavailable' ? previous : { ...previous, status: 'unavailable' }));
      return;
    }
    const cancellation = new AbortController();
    const wanted = new Set(keys);
    // Links already read stay the answer while they are re-read (last known good); only a read that has not
    // answered yet, or one that failed, says it is reading.
    setRead((previous) => (previous.status === 'ready' || previous.status === 'reading'
      ? previous
      : { ...previous, status: 'reading' }));
    void (async () => {
      const links = new Map<string, string[]>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        do {
          const page = await readTriageSessionLinksPageV1(collections.sessionLinks, {
            ...(cursor === undefined ? {} : { cursor }),
          }, { signal: cancellation.signal });
          throwIfAborted(cancellation.signal);
          for (const link of page.links) {
            const key = triageEntryRowKey(link.entryRef);
            if (!wanted.has(key)) continue;
            const sessions = links.get(key) ?? [];
            if (!sessions.includes(link.sessionId)) sessions.push(link.sessionId);
            links.set(key, sessions);
          }
          cursor = page.nextCursor;
          // The Collection continuation is opaque. A repeated position cannot
          // complete the read and is reported with the ordinary retry state.
          if (cursor !== undefined && cursors.has(cursor)) throw new Error('triage:sessionLinks:nonProgress');
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        setRead((previous) => (previous.status === 'ready' && sameLinks(previous.links, links)
          ? previous
          : { links, status: 'ready' }));
      } catch {
        if (cancellation.signal.aborted) return;
        setRead((previous) => {
          // Failed enumeration makes no absence claim. Keep prior links and
          // the pages that did answer, with incompleteness visible to the reader.
          const retained = new Map(previous.links);
          for (const [key, sessions] of links) {
            retained.set(key, Array.from(new Set([...(retained.get(key) ?? []), ...sessions])));
          }
          return { links: retained, status: 'unavailable' };
        });
      }
    })();
    return () => cancellation.abort();
    // keysIdentity is the exact window membership; unrelated render/row facts
    // do not start another link read.
  }, [collections, demand, input.acquisition, input.active, keysIdentity]);

  const sessionIds = useMemo(() => Array.from(new Set(
    keys.flatMap((key) => read.links.get(key) ?? []),
  )), [keysIdentity, read.links]);
  const { sessions, refresh: refreshSessions } = useSessionStates(sessionIds);
  const retry = useCallback(() => {
    setDemand((value) => value + 1);
    refreshSessions();
  }, [refreshSessions]);
  const agentStates = useMemo(() => {
    const byEntry = new Map<string, readonly SessionStateV1[]>();
    for (const key of keys) {
      const states = (read.links.get(key) ?? []).flatMap((id) => {
        const state = sessions.get(id)?.state;
        return state == null ? [] : [state];
      });
      if (states.length > 0) byEntry.set(key, states);
    }
    return byEntry;
  }, [keysIdentity, read.links, sessions]);
  const incomplete = read.status !== 'ready'
    || sessionIds.some((id) => sessions.get(id)?.status !== 'ready');
  return useMemo(() => ({
    agentStates,
    incomplete,
    unavailable: read.status === 'unavailable'
      || sessionIds.some((id) => ['unavailable', 'unsupported'].includes(sessions.get(id)?.status ?? 'loading')),
    retry,
  }), [agentStates, incomplete, read.status, retry, sessionIds, sessions]);
}

function sameLinks(left: LinksByEntry, right: LinksByEntry): boolean {
  if (left.size !== right.size) return false;
  for (const [key, sessions] of right) {
    const previous = left.get(key);
    if (previous === undefined || previous.length !== sessions.length
      || previous.some((sessionId, index) => sessionId !== sessions[index])) return false;
  }
  return true;
}
