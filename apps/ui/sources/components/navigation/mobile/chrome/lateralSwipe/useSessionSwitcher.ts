/**
 * The JS side of the phone's session switcher: which rows each gesture shows, and what opening
 * one does. One owner for every input that moves sessions from the bar — drag up, sideways,
 * flicks, the docked panel and the VoiceOver/TalkBack band actions — so there is exactly one
 * answer to what lies each way and what the person is told about the landing.
 *
 * Ordering is not decided here (`sessionSwitcherOrder` owns both sources); rows are read once per
 * touch (`sessionSwitcherRows`), never subscribed, because this lives in chrome on every session.
 */

import * as React from 'react';

import { usePhoneWorkspaceTabs } from '@/components/appShell/workspace/usePhoneWorkspaceTabs';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursorStore';
import {
    buildServerScopedSessionKey,
    moveSessionMruEntryToFront,
    type SessionNavigationDirection,
} from '@/sync/domains/session/navigation/sessionNavigationOrder';
import {
    resolveSessionSwitcherDirectionalEntries,
    resolveSessionSwitcherFlickTarget,
    resolveSessionSwitcherRecentPool,
    resolveSessionSwitcherVerticalEntries,
    type SessionSwitcherOpenTab,
    type SessionSwitcherSource,
} from '@/sync/domains/session/navigation/sessionSwitcherOrder';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage, useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    buildSessionSwitcherAddressIndex,
    readSessionSwitcherRows,
    type SessionSwitcherRow,
    type SessionSwitcherTabPresentation,
} from './sessionSwitcherRows';

/** Which panel the switcher shows: the vertical one (drag up, hold), or sideways one way. */
export type SessionSwitcherMode = 'up' | SessionNavigationDirection;

export type SessionSwitcherPrepared = Readonly<{
    rows: Readonly<Record<SessionSwitcherMode, readonly SessionSwitcherRow[]>>;
    sources: Readonly<Record<SessionSwitcherMode, SessionSwitcherSource>>;
    /** The row for where you are, for "Here" / "Stay on …". */
    current: SessionSwitcherRow | null;
    /** Open tabs lead the recent order (two or more open). */
    tabsSynced: boolean;
    /** Frozen vertical order; independent of the sideways preference. */
    flickOrder: Readonly<{ rows: readonly SessionSwitcherRow[]; index: number; cycle: boolean }>;
}>;

/** Flicks within this window walk one frozen order (the iOS quick-switch rule). */
const FLICK_BURST_MS = 1500;

type Burst = { rows: readonly SessionSwitcherRow[]; index: number; cycle: boolean; timer: ReturnType<typeof setTimeout> | null };

export type SessionSwitcher = Readonly<{
    /** Reads every row the gestures can show, once per touch. */
    prepare: () => SessionSwitcherPrepared;
    /** Opens a row: a session, or an open tab. Announces the landing. */
    open: (row: SessionSwitcherRow) => void;
    /** One flick that way; false when there is nowhere to go. */
    flick: (direction: SessionNavigationDirection) => SessionSwitcherRow | null;
    /** The band's accessibility step: the nearest row sideways that way. */
    step: (direction: SessionNavigationDirection) => boolean;
}>;

export function useSessionSwitcher(params: Readonly<{ sessionId: string | null; serverId: string | null }>): SessionSwitcher {
    const cursor = useSessionNavigationCursor();
    const phoneTabs = usePhoneWorkspaceTabs();
    const upSource: SessionSwitcherSource = useSetting('sessionSwitcherDragUpSource') === 'list' ? 'list' : 'recent';
    const sideSource: SessionSwitcherSource = useSetting('sessionCockpitSwipeSource') === 'recent' ? 'recent' : 'list';
    const draftScope = useActiveServerAccountScope();
    const navigateToSession = useNavigateToSession();

    const latest = React.useRef({ ...params, cursor, phoneTabs, upSource, sideSource, draftScope, navigateToSession });
    latest.current = { ...params, cursor, phoneTabs, upSource, sideSource, draftScope, navigateToSession };
    const burst = React.useRef<Burst | null>(null);

    const prepare = React.useCallback((): SessionSwitcherPrepared => {
        const { sessionId, serverId, cursor: order, phoneTabs: tabs, draftScope: scope } = latest.current;
        const state = storage.getState() as unknown as Parameters<typeof readSessionSwitcherRows>[0]['state'] & {
            localSettings?: { sessionMruOrderV1?: unknown };
        };
        const cursorEntries = order?.entries ?? [];
        // The current session's key in the shape every other key has: the captured list's entry when
        // it is there (a route opened without a serverId still anchors), else this Home's address.
        const matching = sessionId ? cursorEntries.filter((entry) => entry.sessionId === sessionId) : [];
        const listServerId = matching.length === 1 ? matching[0].serverId ?? null : null;
        const scopedServerId = serverId ?? listServerId ?? scope?.serverId ?? null;
        const currentAddress: SessionAddress | null = sessionId && scopedServerId ? { serverId: scopedServerId, sessionId } : null;
        const currentKey = sessionId ? buildServerScopedSessionKey(sessionId, scopedServerId) : null;

        const openTabs: SessionSwitcherOpenTab[] = [];
        const tabsById = new Map<string, SessionSwitcherTabPresentation>();
        const tabAddresses: SessionAddress[] = [];
        for (const tab of tabs.tabs) {
            if (tab.preview) continue; // The preview is history, not a kept tab: it lives in Recent.
            const session = tab.session && (tab.session.serverId ?? scope?.serverId)
                ? { serverId: (tab.session.serverId ?? scope?.serverId) as string, sessionId: tab.session.sessionId }
                : null;
            if (session) tabAddresses.push(session);
            openTabs.push({ tabId: tab.id, sessionKey: session ? buildServerScopedSessionKey(session.sessionId, session.serverId) : null });
            tabsById.set(tab.id, { tabId: tab.id, title: tab.title, icon: tab.icon, unavailable: tab.unavailable, session, context: tab.context });
        }
        const addressByKey = buildSessionSwitcherAddressIndex(state, [
            ...cursorEntries.flatMap((entry) => (entry.serverId ? [{ serverId: entry.serverId, sessionId: entry.sessionId }] : [])),
            ...tabAddresses,
            ...(currentAddress ? [currentAddress] : []),
        ]);
        const mru = Array.isArray(state.localSettings?.sessionMruOrderV1)
            ? (state.localSettings?.sessionMruOrderV1 as unknown[]).filter((key): key is string => typeof key === 'string')
            : [];
        const normalizedMru = moveSessionMruEntryToFront({ order: mru, activeSessionKey: null, maxEntries: mru.length,
            knownSessionEntries: Array.from(addressByKey, ([sessionKey, address], index) => ({ index, sessionKey, ...address })) });
        const pool = resolveSessionSwitcherRecentPool({ currentKey, mruSessionKeys: normalizedMru, openTabs });
        const listSessionKeys = cursorEntries.map((entry) => entry.sessionKey);
        const read = (entries: Parameters<typeof readSessionSwitcherRows>[0]['entries']) => readSessionSwitcherRows({
            entries, state, addressByKey, tabsById, draftScope: scope, nowMs: Date.now(),
        });
        const { upSource: up, sideSource: side } = latest.current;
        const directional = (direction: SessionNavigationDirection, source = side) => read(resolveSessionSwitcherDirectionalEntries({
            source, direction, currentKey, listSessionKeys, pool,
        }));
        const current = currentKey
            ? read([{ key: currentKey, section: 'recent', sessionKey: currentKey, tabId: null }])[0] ?? null
            : null;
        const vertical = read(resolveSessionSwitcherVerticalEntries({ source: up, currentKey, listSessionKeys, pool }));
        const previous = up === 'list' ? directional('previous', up) : [];
        const flickRows = up === 'list'
            ? [...previous.slice().reverse(), ...(current ? [current] : []), ...directional('next', up)]
            : [...(current ? [current] : []), ...vertical];
        return {
            rows: {
                up: vertical,
                next: directional('next'),
                previous: directional('previous'),
            },
            sources: { up, next: side, previous: side },
            current,
            tabsSynced: openTabs.length >= 2,
            flickOrder: { rows: flickRows, index: current ? previous.length : -1, cycle: up === 'recent' && openTabs.length >= 2 },
        };
    }, []);

    const open = React.useCallback((row: SessionSwitcherRow) => {
        const { navigateToSession: navigate, phoneTabs: tabs } = latest.current;
        if (row.target.kind === 'tab') tabs.activate(row.target.tabId);
        else if (row.target.tabId) tabs.activate(row.target.tabId);
        else fireAndForget(navigate(row.target.sessionId, row.target.serverId ? { serverId: row.target.serverId } : undefined));
        announceAccessibilityMessage(t('phoneNav.switcher.switchedTo', { name: row.title }));
    }, []);

    const flick = React.useCallback((direction: SessionNavigationDirection): SessionSwitcherRow | null => {
        let current = burst.current;
        if (!current) {
            // Freeze the order the flicks walk: the vertical source, with where you are in it.
            const prepared = prepare();
            current = { ...prepared.flickOrder, timer: null };
        }
        const target = resolveSessionSwitcherFlickTarget({
            length: current.rows.length, fromIndex: current.index, direction, cycle: current.cycle,
        });
        if (target === null) return null;
        current.index = target;
        if (current.timer) clearTimeout(current.timer);
        current.timer = setTimeout(() => { burst.current = null; }, FLICK_BURST_MS);
        burst.current = current;
        const row = current.rows[target];
        open(row);
        return row;
    }, [open, prepare]);

    React.useEffect(() => () => {
        if (burst.current?.timer) clearTimeout(burst.current.timer);
    }, []);

    const step = React.useCallback((direction: SessionNavigationDirection): boolean => {
        const row = prepare().rows[direction][0];
        if (!row) return false;
        open(row);
        return true;
    }, [open, prepare]);

    return React.useMemo(() => ({ prepare, open, flick, step }), [flick, open, prepare, step]);
}
