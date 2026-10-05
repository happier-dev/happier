import * as React from 'react';
import { useRouter } from 'expo-router';

import { usePhoneWorkspaceTabs } from '@/components/appShell/workspace/usePhoneWorkspaceTabs';
import {
    buildSessionSwitcherAddressIndex,
    readSessionSwitcherRows,
    type SessionSwitcherRow,
    type SessionSwitcherTabPresentation,
} from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherRows';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { buildServerScopedSessionKey, moveSessionMruEntryToFront } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { resolveSessionSwitcherRecentPool } from '@/sync/domains/session/navigation/sessionSwitcherOrder';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { SessionAllTabsSection } from './SessionAllTabsOverview';

/**
 * Builds All tabs when it opens: the switcher's recent order (`resolveSessionSwitcherRecentPool`) and
 * its row presenter (`readSessionSwitcherRows`), read once from the store — never a subscription on
 * the session screen — so All tabs, the switcher and the rail describe one set the same way.
 */
export function buildSessionAllTabsSections(params: Readonly<{
    rows: readonly SessionSwitcherRow[];
    synced: boolean;
}>): SessionAllTabsSection[] {
    const open = params.rows.filter((row) => row.section === 'openTabs');
    const recent = params.rows.filter((row) => row.section !== 'openTabs');
    const sections: SessionAllTabsSection[] = [];
    if (open.length > 0) {
        sections.push({
            key: 'openTabs',
            title: params.synced ? t('phoneNav.allTabs.openTabsSynced') : t('phoneNav.allTabs.openTabs'),
            rows: open,
        });
    }
    sections.push({
        key: 'recent',
        title: open.length > 0 ? t('phoneNav.allTabs.recent') : t('phoneNav.allTabs.recentOnThisDevice'),
        rows: recent,
    });
    return sections;
}

type PhoneTabs = ReturnType<typeof usePhoneWorkspaceTabs>;

export type SessionAllTabsSnapshot = Readonly<{
    currentKey: string;
    sections: readonly SessionAllTabsSection[];
    rowsByKey: ReadonlyMap<string, SessionSwitcherRow>;
}>;

/** One read of the store when All tabs opens: the switcher's recent order through its row presenter. */
export function readSessionAllTabs(params: Readonly<{
    session: Readonly<{ sessionId: string; serverId: string | null }>;
    phoneTabs: PhoneTabs;
}>): SessionAllTabsSnapshot {
    const { session, phoneTabs } = params;
    const state = storage.getState();
    const currentKey = buildServerScopedSessionKey(session.sessionId, session.serverId);
    const tabs = phoneTabs.tabs.filter((tab) => !tab.preview);
    const openTabs = tabs.map((tab) => ({
        tabId: tab.id,
        sessionKey: tab.session ? buildServerScopedSessionKey(tab.session.sessionId, tab.session.serverId) : null,
    }));
    const mru = state.localSettings.sessionMruOrderV1;
    const extra = [
        ...(session.serverId ? [{ sessionId: session.sessionId, serverId: session.serverId }] : []),
        ...tabs.flatMap(tab => tab.session?.serverId ? [{ sessionId: tab.session.sessionId, serverId: tab.session.serverId }] : []),
    ];
    const addressByKey = buildSessionSwitcherAddressIndex(state as never, extra);
    const normalizedMru = moveSessionMruEntryToFront({ order: Array.isArray(mru) ? mru : [], activeSessionKey: null,
        maxEntries: Array.isArray(mru) ? mru.length : 0,
        knownSessionEntries: Array.from(addressByKey, ([sessionKey, address], index) => ({ index, sessionKey, ...address })) });
    const entries = resolveSessionSwitcherRecentPool({
        currentKey,
        mruSessionKeys: normalizedMru,
        openTabs,
    });
    const tabsById = new Map<string, SessionSwitcherTabPresentation>(tabs.map((tab) => [tab.id, {
        tabId: tab.id,
        title: tab.title,
        icon: tab.icon,
        unavailable: tab.unavailable,
        context: tab.context,
        session: tab.session && tab.session.serverId
            ? { sessionId: tab.session.sessionId, serverId: tab.session.serverId }
            : null,
    }]));
    const rows = readSessionSwitcherRows({
        entries,
        state: state as never,
        addressByKey,
        tabsById,
        draftScope: getActiveServerAccountScope(),
        nowMs: Date.now(),
    });
    return {
        currentKey,
        sections: buildSessionAllTabsSections({ rows, synced: state.settings.workspaceTabsSyncEnabled !== false }),
        rowsByKey: new Map(rows.map((row) => [row.key, row])),
    };
}

/** Opens All tabs: a full page over the session (`/all-tabs`), so Back and Done return to it. */
export function useSessionAllTabsOpener(session: Readonly<{ sessionId: string; serverId: string | null }>): () => void {
    const router = useRouter();
    const latest = React.useRef(session);
    latest.current = session;
    return React.useCallback(() => {
        const current = latest.current;
        router.push({ pathname: '/all-tabs', params: { sessionId: current.sessionId, ...(current.serverId ? { serverId: current.serverId } : null) } });
    }, [router]);
}

/**
 * The All tabs page's data and its one action. The snapshot is taken once, when the page opens, so
 * cards do not reshuffle under the finger; opening a card leaves the page and goes there.
 */
export function useSessionAllTabsPage(session: Readonly<{ sessionId: string; serverId: string | null }>): Readonly<{
    snapshot: SessionAllTabsSnapshot;
    open: (key: string) => void;
    done: () => void;
}> {
    const router = useRouter();
    const phoneTabs = usePhoneWorkspaceTabs();
    const navigateToSession = useNavigateToSession();
    const [snapshot] = React.useState(() => readSessionAllTabs({ session, phoneTabs }));
    const latest = React.useRef({ phoneTabs, navigateToSession });
    latest.current = { phoneTabs, navigateToSession };
    const done = React.useCallback(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/');
    }, [router]);
    const open = React.useCallback((key: string) => {
        const row = snapshot.rowsByKey.get(key);
        done();
        if (!row || key === snapshot.currentKey) return;
        const { phoneTabs: tabs, navigateToSession: navigate } = latest.current;
        if (row.target.kind === 'tab') { tabs.activate(row.target.tabId); return; }
        if (row.target.tabId) { tabs.activate(row.target.tabId); return; }
        fireAndForget(navigate(row.target.sessionId, row.target.serverId ? { serverId: row.target.serverId } : undefined));
    }, [done, snapshot]);
    return { snapshot, open, done };
}

/**
 * Keeps the session screen's All tabs opener current without the screen subscribing to the
 * workspace: this leaf re-renders on tab changes, the screen above it does not.
 */
export function SessionAllTabsOpenerBridge(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    openRef: React.MutableRefObject<(() => void) | null>;
}>): null {
    const open = useSessionAllTabsOpener({ sessionId: props.sessionId, serverId: props.serverId });
    props.openRef.current = open;
    return null;
}
