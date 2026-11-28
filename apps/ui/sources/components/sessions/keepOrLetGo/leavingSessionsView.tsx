import * as React from 'react';

import type { SessionLeavingRule } from '@/sync/api/session/apiSessionLeaving';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';
import {
    retainLeavingSessions,
    useLeavingSessionsValue,
    type LeavingSession,
    type LeavingSessionsData,
    type LeavingSessionsEntry,
} from '@/sync/domains/session/retention/leavingSessionsResource';
import { storage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';

import { formatLeavingRowLabel } from './keepOrLetGoCopy';

/**
 * What the session list shows about leaving sessions: the leaving read minus anything pinned since.
 *
 * One provider per list mount owns the read (its demand) and publishes this view through context, so
 * the foot and every row read the same projection: a row's "Leaves 31 Dec" label is one map lookup,
 * not a store subscription per row. The view's identity changes only when the leaving read or the
 * pinned membership of its sessions changes, so session list arrivals re-render nothing here.
 */
export type LeavingSessionsView = Readonly<{
    serverId: string;
    rule: SessionLeavingRule;
    /** Unpinned leaving sessions, soonest first. */
    sessions: readonly LeavingSession[];
    leavesAtById: ReadonlyMap<string, number>;
    /** Server count less the sessions pinned since the read. */
    count: number;
    soonestLeavesAt: number;
    newestLeavesAt: number;
}>;

const LeavingSessionsViewContext = React.createContext<LeavingSessionsView | null>(null);

const EMPTY_SESSIONS: readonly LeavingSession[] = Object.freeze([]);
const selectEntry = (entry: LeavingSessionsEntry) => entry;

/**
 * The pinned members of a leaving read, as a newline-joined id list: a stable primitive, so a store
 * selector over it renders nothing on an unrelated store change.
 */
export function selectPinnedLeavingKey(state: StorageState, serverId: string, sessions: readonly LeavingSession[]): string {
    let key = '';
    for (const session of sessions) {
        if (state.sessionOrganizationPinsBySessionKey[buildSessionOrganizationServerKey(serverId, session.id)]) {
            key += `${session.id}\n`;
        }
    }
    return key;
}

/** The one projection of a leaving read into what the list and the Keep stack show. */
export function projectLeavingSessionsView(
    serverId: string,
    data: LeavingSessionsData | null,
    pinnedKey: string,
): LeavingSessionsView | null {
    if (!data) return null;
    const pinnedIds = new Set(pinnedKey.split('\n').filter(Boolean));
    const sessions = pinnedIds.size === 0 ? data.sessions : data.sessions.filter((session) => !pinnedIds.has(session.id));
    if (sessions.length === 0) return null;
    return {
        serverId,
        rule: data.rule,
        sessions,
        leavesAtById: sessions === data.sessions
            ? data.leavesAtById
            : new Map(sessions.map((session) => [session.id, session.leavesAt])),
        count: Math.max(sessions.length, data.count - (data.sessions.length - sessions.length)),
        soonestLeavesAt: sessions[0]!.leavesAt,
        newestLeavesAt: sessions[sessions.length - 1]!.leavesAt,
    };
}

function useLeavingSessionsViewValue(enabled: boolean): LeavingSessionsView | null {
    const entry = useLeavingSessionsValue(selectEntry);
    React.useEffect(() => (enabled ? retainLeavingSessions() : undefined), [enabled, entry.serverId]);
    // "off" carries no data; an error keeps the last-known data on screen.
    const data = entry.status === 'off' ? null : entry.data;
    const sessions = data?.sessions ?? EMPTY_SESSIONS;
    const serverId = entry.serverId;
    const pinnedKey = storage(React.useCallback(
        (state: StorageState) => selectPinnedLeavingKey(state, serverId, sessions),
        [serverId, sessions],
    ));
    return React.useMemo(
        () => (enabled ? projectLeavingSessionsView(serverId, data, pinnedKey) : null),
        [data, enabled, pinnedKey, serverId],
    );
}

export function LeavingSessionsProvider(props: Readonly<{ enabled: boolean; children: React.ReactNode }>) {
    const view = useLeavingSessionsViewValue(props.enabled);
    return (
        <LeavingSessionsViewContext.Provider value={view}>
            {props.children}
        </LeavingSessionsViewContext.Provider>
    );
}

export function useLeavingSessionsView(): LeavingSessionsView | null {
    return React.useContext(LeavingSessionsViewContext);
}

/** The row subtitle for a leaving session, or null. One lookup in the published view. */
export function useLeavingSessionRowLabel(sessionId: string, serverId: string | null | undefined): string | null {
    const view = React.useContext(LeavingSessionsViewContext);
    if (!view) return null;
    if (serverId && serverId !== view.serverId) return null;
    const leavesAt = view.leavesAtById.get(sessionId);
    return leavesAt === undefined ? null : formatLeavingRowLabel(leavesAt, Date.now());
}
