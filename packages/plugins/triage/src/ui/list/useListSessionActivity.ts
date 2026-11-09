import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePluginHostApi, useSessionStates, usePluginUiEphemeralSharedScope, type PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { triageEntryRowKey } from '../../projection/listWindow.js';
import type { InternalTaskListProjection } from '../../internalTasks/listProjection.js';
import { INTERNAL_TASK_DATA_UNAVAILABLE_V1 } from '../../internalTasks/failure.js';
import type { TriageAgentStateV1 } from '../detail/agentState.js';
import { TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, TriageReadSourceSessionLinksActionResultV1Schema, normalizeTriageSourceSessionLinksCoverageV1 } from '../../actions/sessionLinksProtocol.js';

type LinksByEntry = ReadonlyMap<string, readonly string[]>;
type LinkRead = Readonly<{ owner: PluginUiEphemeralSharedScope | null; links: LinksByEntry;
  status: 'reading' | 'ready' | 'unavailable'; linkedReadFailed: boolean }>;

/** Produce the keyed Session-id projection against its admitted baseline. */
function projectLinkRead(previous: LinkRead, owner: LinkRead['owner'], links: LinksByEntry,
  status: LinkRead['status'], linkedReadFailed = false): LinkRead {
  const baseline = previous.owner === owner ? previous.links : undefined;
  const projected = new Map<string, readonly string[]>();
  let unchanged = baseline !== undefined && baseline.size === links.size;
  for (const [key, sessions] of links) {
    const retained = baseline?.get(key);
    const same = retained !== undefined && retained.length === sessions.length
      && sessions.every((sessionId, index) => sessionId === retained[index]);
    projected.set(key, same ? retained : sessions);
    if (!same) unchanged = false;
  }
  const value = unchanged && baseline !== undefined ? baseline : projected;
  return previous.owner === owner && previous.status === status && previous.links === value
    && previous.linkedReadFailed === linkedReadFailed
    ? previous : { owner, links: value, status, linkedReadFailed };
}

function selectAgentState(state: SessionStateV1): TriageAgentStateV1 {
  return {
    lifecycle: state.lifecycle,
    operational: state.operational,
    workStatus: { bucket: state.workStatus.bucket, tone: state.workStatus.tone },
    ...(state.agent === undefined ? {} : { agent: state.agent }),
  };
}

/** Only the Agents lens says what a Session is about, so a renamed Session re-renders no other list. */
function selectAgentStateWithTitle(state: SessionStateV1): TriageAgentStateV1 {
  return { ...selectAgentState(state), ...(state.title === undefined ? {} : { title: state.title }) };
}

/**
 * One mounted list join: the composed relation Action supplies relationships,
 * and the host's shared Session hook supplies current Work facts. Acquisition is
 * relation-addressed once for the demanded window, never placed on each
 * row. Only selected relations are read; no entry detail bodies are acquired.
 */
export function useTriageListSessionActivityV1(input: Readonly<{
  entryRefs: readonly TriageEntryRefV1[];
  /** Moves once per list pass that read (`TriageListWindowSnapshotV1.passes`); each move re-reads the links once. */
  acquisition: unknown;
  active: boolean;
  /** The list says what each Session is about (the Agents lens). */
  withSessionTitle?: boolean;
  /** The list winner's selected connection, independent of relation ownership. */
  sourceInstanceIds?: ReadonlyMap<string, string>;
  taskProjection?: InternalTaskListProjection;
  refreshList?: () => void;
}>): Readonly<{
  /** The live states of each listed entry's linked Sessions that have answered, by row key. */
  agentStates: ReadonlyMap<string, readonly TriageAgentStateV1[]>;
  /** Relationship truth survives unreadable or stopped Session activity. */
  linkedSessions: LinksByEntry;
  linksStatus: LinkRead['status'];
  incomplete: boolean;
  unavailable: boolean;
  unreachable: boolean;
  retry(): void;
}> {
  const host = usePluginHostApi();
  const owner = usePluginUiEphemeralSharedScope();
  const keys = input.entryRefs.map(triageEntryRowKey).sort();
  const keysIdentity = JSON.stringify(keys);
  const [read, setRead] = useState<LinkRead>({ owner, links: new Map(), status: 'reading', linkedReadFailed: false });
  const [demand, setDemand] = useState(0);

  useEffect(() => {
    if (!input.active) return;
    if (keys.length === 0) {
      setRead((previous) => (previous.owner === owner && previous.status === 'ready' && previous.links.size === 0
        ? previous
        : { owner, links: new Map(), status: 'ready', linkedReadFailed: false }));
      return;
    }
    const cancellation = new AbortController();
    const entries = new Map(input.entryRefs.map((entryRef) => [triageEntryRowKey(entryRef), entryRef]));
    // Links already read stay the answer while they are re-read (last known good); only a read that has not
    // answered yet, or one that failed, says it is reading.
    setRead((previous) => previous.owner !== owner ? { owner, links: new Map(), status: 'reading', linkedReadFailed: false }
      : (previous.status === 'ready' || previous.status === 'reading'
      ? previous
      : { ...previous, status: 'reading' }));
    void (async () => {
      const links = new Map<string, string[]>();
      // Null means the batch itself could not be read. A parsed batch instead
      // identifies the exact entries whose relationship coverage is incomplete.
      let failedEntries: ReadonlySet<string> | null = null;
      try {
        const admitted = new Map(input.taskProjection?.entries.map(entry => [triageEntryRowKey(entry.entryRef), entry]));
        const projected = [];
        const selected = [];
        for (const entryRef of entries.values()) {
          const sourceInstanceId = input.sourceInstanceIds?.get(triageEntryRowKey(entryRef));
          const entry = admitted.get(triageEntryRowKey(entryRef));
          if (entry !== undefined) projected.push(entry);
          else if (sourceInstanceId !== undefined && sourceInstanceId === input.taskProjection?.sourceInstanceId) {
            projected.push({ entryRef, result: { kind: 'failed' as const, links: [], lanes: [{ source: entryRef.source,
              sourceInstanceId, displayLabel: sourceInstanceId, kindIds: [entryRef.kindId], health: { kind: 'failed' as const,
                failure: input.taskProjection.failure ?? INTERNAL_TASK_DATA_UNAVAILABLE_V1 } }] } });
          } else selected.push({ entryRef, ...(sourceInstanceId === undefined ? {} : { sourceInstanceId }) });
        }
        const result = selected.length === 0 ? { kind: 'entries' as const, entries: [] }
          : TriageReadSourceSessionLinksActionResultV1Schema.parse(await host.executeAction(
          TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1,
          { v: 1, entries: selected },
          { signal: cancellation.signal },
        ));
        if (result.kind !== 'entries') throw new Error('triage:sessionLinks:invalidBatchResult');
        const incomplete = new Set<string>();
        for (const entry of [...projected, ...result.entries]) {
          const relation = normalizeTriageSourceSessionLinksCoverageV1(entry.result);
          const key = triageEntryRowKey(entry.entryRef);
          if (!entries.has(key)) throw new Error('triage:sessionLinks:unexpectedEntry');
          if (relation.kind === 'complete' || relation.links.length > 0) {
            links.set(key, Array.from(new Set(relation.links.map(link => link.sessionId))));
          }
          if (relation.kind !== 'complete') incomplete.add(key);
        }
        if (projected.length + result.entries.length !== entries.size) throw new Error('triage:sessionLinks:incomplete');
        failedEntries = incomplete;
        if (incomplete.size > 0) throw new Error('triage:sessionLinks:incomplete');
        throwIfAborted(cancellation.signal);
        setRead(previous => projectLinkRead(previous, owner, links, 'ready'));
      } catch (error) {
        if (cancellation.signal.aborted) return;
        host.diagnostic({
          code: 'triage_session_links_read_unavailable', severity: 'warning',
          message: error instanceof Error ? error.message : 'Session links could not be read',
          ...(isPluginError(error) ? { details: { code: error.code, retryable: error.retryable } } : {}),
        });
        setRead((previous) => {
          // Failed enumeration makes no absence claim. Keep prior links and
          // the pages that did answer, with incompleteness visible to the reader.
          const retained = new Map(previous.owner === owner ? [...previous.links].filter(([key]) => entries.has(key)) : []);
          for (const [key, sessions] of links) {
            retained.set(key, sessions);
          }
          const linkedReadFailed = Array.from(retained).some(([key, sessions]) => sessions.length > 0
            && (failedEntries === null || failedEntries.has(key)));
          return projectLinkRead(previous, owner, retained, 'unavailable', linkedReadFailed);
        });
      }
    })();
    return () => cancellation.abort();
    // keysIdentity is the exact window membership; unrelated render/row facts
    // do not start another link read.
  }, [owner, demand, host, input.acquisition, input.active, input.sourceInstanceIds, input.taskProjection, keysIdentity]);

  const currentRead = read.owner === owner ? read : { owner, links: new Map<string, readonly string[]>(),
    status: 'reading' as const, linkedReadFailed: false };

  const sessionIds = useMemo(() => Array.from(new Set(
    keys.flatMap((key) => currentRead.links.get(key) ?? []),
  )), [keysIdentity, currentRead.links]);
  const { sessions, refresh: refreshSessions } = useSessionStates(sessionIds, { select: input.withSessionTitle === true ? selectAgentStateWithTitle : selectAgentState });
  const retry = useCallback(() => {
    if (input.refreshList !== undefined) input.refreshList();
    else setDemand((value) => value + 1);
    refreshSessions();
  }, [refreshSessions, input.refreshList]);
  const previousAgentStates = useRef<ReadonlyMap<string, readonly TriageAgentStateV1[]>>(new Map());
  const agentStates = useMemo(() => {
    const previous = previousAgentStates.current;
    const byEntry = new Map<string, readonly TriageAgentStateV1[]>();
    for (const key of keys) {
      const states = (currentRead.links.get(key) ?? []).flatMap((id) => {
        const state = sessions.get(id)?.state;
        return state == null ? [] : [state];
      });
      if (states.length > 0) {
        const retained = previous.get(key);
        byEntry.set(key, retained !== undefined && retained.length === states.length
          && states.every((state, index) => state === retained[index]) ? retained : states);
      }
    }
    if (byEntry.size === previous.size && Array.from(byEntry).every(([key, states]) => previous.get(key) === states)) return previous;
    previousAgentStates.current = byEntry;
    return byEntry;
  }, [keysIdentity, currentRead.links, sessions]);
  // Failed enumeration cannot establish that any listed row has a link. Only
  // known linked Sessions can have unreadable activity; empty rows stay quiet.
  const unavailable = currentRead.linkedReadFailed || sessionIds.some((id) => {
    const read = sessions.get(id);
    return read?.status === 'unavailable' && read.retryable !== false;
  });
  const incomplete = currentRead.status === 'reading' || unavailable
    || sessionIds.some((id) => (sessions.get(id)?.status ?? 'loading') === 'loading');
  const unreachable = sessionIds.some((id) => {
    const read = sessions.get(id);
    return read?.status === 'missing' || read?.status === 'unsupported'
      || (read?.status === 'unavailable' && read.retryable === false);
  });
  return useMemo(() => ({
    agentStates,
    linkedSessions: currentRead.links,
    linksStatus: currentRead.status,
    incomplete,
    unavailable,
    unreachable,
    retry,
  }), [agentStates, incomplete, currentRead.links, currentRead.status, unavailable, unreachable, retry]);
}
