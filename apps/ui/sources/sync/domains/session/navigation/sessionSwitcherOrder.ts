/**
 * The two orders the phone's session switcher can show, and how a gesture walks them.
 *
 * The switcher (drag the bar up, swipe it sideways, flick it, or hold it) is one surface with one
 * row model; only the source list changes, and each gesture picks its own source in settings:
 *
 * - `list`: the Sessions list as the person last saw it — the frozen cursor order that the
 *   sideways swipe has always stepped through (`sessionNavigationCursor`).
 * - `recent`: what this device opened, by time. Open tabs lead when two or more are open
 *   (the rail is a set the person chose to keep), then this device's navigation history.
 *
 * Keys are session address keys (`sessionAddressKey`, the same keys the cursor and the MRU store)
 * and `tab:<id>` for an open tab, so a session that is open as a tab appears once, as the tab.
 * Pure module: no React, no store.
 */

import type { SessionNavigationDirection } from './sessionNavigationOrder';

export type SessionSwitcherSource = 'recent' | 'list';
export type SessionSwitcherSection = 'openTabs' | 'recent' | 'list';

/** An open tab in rail order; `sessionKey` is set when the tab shows a session. */
export type SessionSwitcherOpenTab = Readonly<{ tabId: string; sessionKey: string | null }>;

export type SessionSwitcherEntry = Readonly<{
    key: string;
    section: SessionSwitcherSection;
    /** The session this row opens, when it is a session. */
    sessionKey: string | null;
    /** The open tab this row activates, when it is one. */
    tabId: string | null;
}>;

/** The rail exists, and leads the recent order, only once a second tab is open. */
const MINIMUM_OPEN_TABS = 2;

const tabEntry = (tab: SessionSwitcherOpenTab): SessionSwitcherEntry => ({
    key: `tab:${tab.tabId}`, section: 'openTabs', sessionKey: tab.sessionKey, tabId: tab.tabId,
});

const sessionEntry = (sessionKey: string, section: SessionSwitcherSection): SessionSwitcherEntry => ({
    key: sessionKey, section, sessionKey, tabId: null,
});

function isCurrent(entry: SessionSwitcherEntry, currentKey: string | null): boolean {
    return currentKey !== null && entry.sessionKey === currentKey;
}

/**
 * The whole recent order, most recent first, the current one included (it is "Here").
 * A session that is not yet in the device's recents is still the most recent thing on screen.
 */
export function resolveSessionSwitcherRecentPool(params: Readonly<{
    currentKey: string | null;
    mruSessionKeys: readonly string[];
    openTabs: readonly SessionSwitcherOpenTab[];
}>): SessionSwitcherEntry[] {
    const mru = params.currentKey && !params.mruSessionKeys.includes(params.currentKey)
        ? [params.currentKey, ...params.mruSessionKeys]
        : [...params.mruSessionKeys];
    const tabs = params.openTabs.length >= MINIMUM_OPEN_TABS ? params.openTabs : [];
    const rank = (tab: SessionSwitcherOpenTab) => {
        const index = tab.sessionKey ? mru.indexOf(tab.sessionKey) : -1;
        return index < 0 ? Number.POSITIVE_INFINITY : index;
    };
    // Stable: tabs no recent ranks keep their rail order behind the ranked ones.
    const orderedTabs = tabs
        .map((tab, railIndex) => ({ tab, railIndex, rank: rank(tab) }))
        .sort((left, right) => left.rank - right.rank || left.railIndex - right.railIndex)
        .map(({ tab }) => tabEntry(tab));
    const tabbedSessions = new Set(tabs.flatMap((tab) => (tab.sessionKey ? [tab.sessionKey] : [])));
    const recents = mru.filter((key) => !tabbedSessions.has(key)).map((key) => sessionEntry(key, 'recent'));
    return [...orderedTabs, ...recents];
}

/** Drag-up rows, nearest the bar first: everything in the source except the current one. */
export function resolveSessionSwitcherVerticalEntries(params: Readonly<{
    source: SessionSwitcherSource;
    currentKey: string | null;
    listSessionKeys: readonly string[];
    pool: readonly SessionSwitcherEntry[];
}>): SessionSwitcherEntry[] {
    if (params.source === 'list') {
        return params.listSessionKeys
            .filter((key) => key !== params.currentKey)
            .map((key) => sessionEntry(key, 'list'));
    }
    return params.pool.filter((entry) => !isCurrent(entry, params.currentKey));
}

/**
 * Sideways rows that way, nearest first. In the list, next lies further down it; in recent, next
 * lies further back in time. Empty when the current one is not in the source: a step whose anchor
 * is gone must do nothing rather than jump to an end.
 */
export function resolveSessionSwitcherDirectionalEntries(params: Readonly<{
    source: SessionSwitcherSource;
    direction: SessionNavigationDirection;
    currentKey: string | null;
    listSessionKeys: readonly string[];
    pool: readonly SessionSwitcherEntry[];
}>): SessionSwitcherEntry[] {
    const order = params.source === 'list'
        ? params.listSessionKeys.map((key) => sessionEntry(key, 'list'))
        : params.pool;
    const index = order.findIndex((entry) => isCurrent(entry, params.currentKey));
    if (index < 0) return [];
    return params.direction === 'next'
        ? order.slice(index + 1)
        : order.slice(0, index).reverse();
}

/**
 * One flick from `fromIndex` in a frozen order. Open tabs cycle (they are a small chosen set);
 * a longer order stops at its ends. Null when there is nowhere to go.
 */
export function resolveSessionSwitcherFlickTarget(params: Readonly<{
    length: number;
    fromIndex: number;
    direction: SessionNavigationDirection;
    cycle: boolean;
}>): number | null {
    const { length, fromIndex } = params;
    if (length < 2 || fromIndex < 0 || fromIndex >= length) return null;
    const target = fromIndex + (params.direction === 'next' ? 1 : -1);
    if (target >= 0 && target < length) return target;
    return params.cycle ? (target + length) % length : null;
}
