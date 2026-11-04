import * as React from 'react';

import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import type { SessionListBotRowsByServerId } from '@/sync/store/domains/sessionListBotSelection';
import { resolveSessionListOrganizationServerIds } from '@/sync/domains/session/organization/sessionListOrganizationServerIds';
import { storage } from '@/sync/domains/state/storage';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { ALL_SESSIONS_RECORDING_VISIBLE, type SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';

import { orderBots, readBotActivity, type BotOrderRow, type OrderedBot } from './botActivity';

/** How many faces the closed Bots entries show before the roster opens (lab `b-rail Ap`). */
const SUMMARY_FACE_COUNT = 3;

/** What a closed Bots entry says: the loaded Bots that need you, and a few faces, needs-you first. */
export type BotsSummary = Readonly<{
  needsYou: number;
  faces: readonly Pick<OrderedBot, 'key' | 'face' | 'activity'>[];
}>;

const EMPTY_SUMMARY: BotsSummary = { needsYou: 0, faces: [] };

const EMPTY_ORDER: readonly OrderedBot[] = [];

/** The Homes whose Bots the closed entries read: the same Homes the Sessions list presents. */
export function useBotsHomeServerIds(): readonly string[] {
  const selection = useSessionListSelectionState();
  return React.useMemo(
    () =>
      resolveSessionListOrganizationServerIds({
        allowedServerIds: selection.allowedServerIds,
        activeServerId: selection.activeServerId,
      }),
    [selection.activeServerId, selection.allowedServerIds],
  );
}

/**
 * The one summary of loaded Bots for always-mounted entries (the rail's Bots badge, the phone's Bots row
 * in My work). The Session-list publisher retains these Bot-only maps across ordinary arrivals.
 * Activity comes from the roster's own classifier.
 */
export function createBotsPresentationReader(
  serverIds: readonly string[],
  isSessionVisible: SessionRecordingVisibility = ALL_SESSIONS_RECORDING_VISIBLE,
): (rowsByServerId: SessionListBotRowsByServerId, nowMs: number) => readonly OrderedBot[] {
  let readRows: ReadonlyArray<SessionListBotRowsByServerId[string]> | null = null;
  let source: readonly BotOrderRow[] = [];
  let homeSources: ReadonlyArray<readonly BotOrderRow[]> = [];
  let ordered = EMPTY_ORDER;
  let observedAt: number | null = null;
  return (rowsByServerId, nowMs) => {
    const rows = serverIds.map((serverId) => rowsByServerId[serverId]);
    const sameRows = readRows !== null && rows.every((homeRows, index) => homeRows === readRows![index]);
    if (sameRows && observedAt === nowMs) return ordered;
    const previous = observedAt === null ? undefined : { rows: source, ordered, nowMs: observedAt };
    if (!sameRows) {
      homeSources = rows.map((homeRows, index) => {
        if (readRows && homeRows === readRows[index]) return homeSources[index]!;
        const prior = new Map(homeSources[index]?.map(row => [row.sessionId, row]));
        return homeRows ? Object.values(homeRows).filter(session => isSessionVisible({ serverId: serverIds[index]!, sessionId: session.id })).map(session => {
          const previousRow = prior.get(session.id);
          if (previousRow?.session === session) return previousRow;
          const serverId = serverIds[index]!;
          return { serverId, sessionId: session.id, session };
        }) : [];
      });
      source = homeSources.flat();
    }
    readRows = rows;
    ordered = orderBots(source, nowMs, undefined, previous);
    observedAt = nowMs;
    return ordered;
  };
}

/** Closed entries are a presentation slice of the complete loaded-Bot projection. */
export function createBotsSummaryReader(serverIds: readonly string[], isSessionVisible: SessionRecordingVisibility = ALL_SESSIONS_RECORDING_VISIBLE) {
  const read = createBotsPresentationReader(serverIds, isSessionVisible);
  let previous = EMPTY_ORDER;
  let summary = EMPTY_SUMMARY;
  return (rowsByServerId: SessionListBotRowsByServerId, nowMs: number): BotsSummary => {
    const bots = read(rowsByServerId, nowMs);
    if (bots === previous) return summary;
    previous = bots;
    const needsYou = bots.filter(bot => bot.activity === 'needsYou').length;
    const faces = bots.slice(0, SUMMARY_FACE_COUNT).map(({ key, face, activity }, index) => {
      const prior = summary.faces[index];
      return prior?.key === key && prior.face === face && prior.activity === activity ? prior : { key, face, activity };
    });
    if (needsYou === summary.needsYou && faces.length === summary.faces.length
      && faces.every((face, index) => face === summary.faces[index])) return summary;
    summary = { needsYou, faces };
    return summary;
  };
}

/** Raw pushes reconcile the existing clock's deadline without publishing semantic changes. */
function useBotsSelection<T>(
  serverIds: readonly string[],
  read: (rows: SessionListBotRowsByServerId, nowMs: number) => T,
  enabled = true,
  selectionDeadline?: (nowMs: number) => number | null,
  isSessionVisible: SessionRecordingVisibility = ALL_SESSIONS_RECORDING_VISIBLE,
): T {
  const sourceNowMs = React.useRef<number | null>(null);
  const nextRefresh = React.useCallback((nowMs: number) => {
    // The clock supplies this instant on source reconciliation too, even when a heartbeat
    // only moves a deadline and does not notify the renderer. New rows use that fresh instant.
    sourceNowMs.current = nowMs;
    if (!enabled) return null;
    if (selectionDeadline) return selectionDeadline(nowMs);
    const rows = storage.getState().sessionListBotRowsByServerId;
    let next: number | null = null;
    for (const serverId of serverIds) for (const session of Object.values(rows[serverId] ?? {})) {
      if (!isSessionVisible({ serverId, sessionId: session.id })) continue;
      const at = readSessionStatusNextRefreshAtMs(session, nowMs);
      if (at !== null && (next === null || at < next)) next = at;
    }
    return next;
  }, [enabled, selectionDeadline, serverIds, isSessionVisible]);
  const subscribeDeadlineChanges = React.useCallback((listener: () => void) => storage.subscribe((state, previous) => {
    if (serverIds.some(id => state.sessionListBotRowsByServerId[id] !== previous.sessionListBotRowsByServerId[id])) listener();
  }), [serverIds]);
  const nowMs = useSessionListRuntimeDeadlineNowMs(nextRefresh, enabled, undefined, subscribeDeadlineChanges);
  return storage(state => read(state.sessionListBotRowsByServerId, Math.max(nowMs, sourceNowMs.current ?? nowMs)));
}

/** N3/N4 consume the full projection; closed entries alone take three faces. */
export function useOrderedBots(enabled = true): readonly OrderedBot[] {
  const serverIds = useBotsHomeServerIds();
  const isSessionVisible = useSessionRecordingVisibility(enabled);
  const read = React.useMemo(() => enabled ? createBotsPresentationReader(serverIds, isSessionVisible) : () => EMPTY_ORDER, [enabled, serverIds, isSessionVisible]);
  return useBotsSelection(serverIds, read, enabled, undefined, isSessionVisible);
}

/** A pin reads only its marker. Its position remains with the person's rail order. */
export function useBotActivity(address: SessionAddress) {
  const serverIds = React.useMemo(() => [address.serverId], [address.serverId]);
  const read = React.useCallback((rows: SessionListBotRowsByServerId, nowMs: number) => {
    const session = rows[address.serverId]?.[address.sessionId];
    return session ? readBotActivity(session, nowMs) : 'quiet';
  }, [address.serverId, address.sessionId]);
  const nextRefresh = React.useCallback((nowMs: number) => {
    const session = storage.getState().sessionListBotRowsByServerId[address.serverId]?.[address.sessionId];
    return session ? readSessionStatusNextRefreshAtMs(session, nowMs) : null;
  }, [address.serverId, address.sessionId]);
  return useBotsSelection(serverIds, read, true, nextRefresh);
}

/** The loaded-Bots summary, subscribed narrowly: unrelated store changes keep the same object. */
export function useBotsSummary(): BotsSummary {
  const serverIds = useBotsHomeServerIds();
  const isSessionVisible = useSessionRecordingVisibility();
  const read = React.useMemo(() => createBotsSummaryReader(serverIds, isSessionVisible), [serverIds, isSessionVisible]);
  return useBotsSelection(serverIds, read, true, undefined, isSessionVisible);
}
