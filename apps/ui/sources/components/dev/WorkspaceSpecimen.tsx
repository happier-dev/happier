import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceEmptyTab, createWorkspaceState, reduceWorkspaceState, type WorkspaceTab } from '@/components/appShell/workspace/workspaceState';
import { WorkspaceTitleBar } from '@/components/appShell/workspace/titleBar/WorkspaceTitleBar';
import { createWorkspaceBarGeometry, WorkspaceBarGeometryContext } from '@/components/appShell/workspace/titleBar/workspaceBarGeometry';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';

/** Dev-only, local-memory fixture: real tab/title/status owners; no account writes or session RPCs. */
const HOME = 'workspace-specimen';
const TITLES: Readonly<Record<string, string>> = {
    fix: 'Fix settings modal remount', review: 'Review #2481', relay: 'Relay retry with backoff',
    failed: 'Nightly release · run 214', offline: 'Studio', docs: 'Docs search index',
};
type Frame = 'T' | 'V' | 'S';

function sessionRow(id: string, state: 'working' | 'attention' | 'failed' | 'offline' | 'idle'): SessionListRenderableSession {
    const now = Date.now();
    return {
        id, encryptionMode: 'plain', encryptedContentAvailability: 'ready', seq: 1,
        createdAt: now, updatedAt: now, active: true, activeAt: now,
        metadataVersion: 1, agentStateVersion: 1,
        metadata: { name: TITLES[id] ?? id, path: '/Developer/happier', host: 'Studio' },
        thinking: false, thinkingAt: 0, presence: state === 'offline' ? now - 1000 : 'online',
        latestTurnStatus: state === 'working' ? 'in_progress' : state === 'failed' ? 'failed' : 'completed',
        latestTurnStatusObservedAt: now,
        hasPendingPermissionRequests: state === 'attention', hasPendingUserActionRequests: false,
        pendingRequestObservedAt: state === 'attention' ? now : null,
    };
}

function fixtureRows() {
    return Object.fromEntries([
        sessionRow('fix', 'working'), sessionRow('review', 'attention'), sessionRow('relay', 'working'),
        sessionRow('failed', 'failed'), sessionRow('offline', 'offline'), sessionRow('docs', 'idle'),
    ].map((row) => [row.id, row]));
}

function fixtureTab(id: string): WorkspaceTab {
    return { id, target: { kind: 'session', params: { id, serverId: HOME } }, pinned: false, preview: id === 'docs' };
}

function fixtureState(frame: Frame) {
    let state = createWorkspaceState(fixtureTab('fix'));
    const ids = frame === 'V' ? ['review', 'relay', 'failed', 'offline', 'docs'] : ['review', 'failed', 'offline'];
    for (const id of ids) state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: fixtureTab(id) });
    if (frame === 'V') for (const id of ['fix', 'review', 'relay', 'failed', 'offline', 'docs']) {
        const original = fixtureTab(id);
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: { ...original, id: `${id}-second`, preview: false }, fallbackTitle: TITLES[id] });
    }
    for (const id of Object.keys(state.tabs)) state = reduceWorkspaceState(state, { type: 'setFallbackTitle', tabId: id, title: TITLES[id] ?? id });
    // Seed undo through the actual close owner, preserving the original instance and order.
    state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: 'review', newTab: createWorkspaceEmptyTab('empty') });
    if (frame === 'S') state = reduceWorkspaceState(state, {
        type: 'splitTab', tabId: 'offline', sourceGroupId: 'group:1', targetGroupId: 'group:1',
        newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200,
        minimumFirstSizePx: 300, minimumSecondSizePx: 300,
    });
    return reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'fix' });
}

export function WorkspaceSpecimen(props: Readonly<{ frame: string | null }>) {
    const frame: Frame = props.frame === 'V' || props.frame === 'S' ? props.frame : 'T';
    const catalog = useCompactAppDestinations();
    const [state, setState] = React.useState(() => fixtureState(frame));
    const [geometry] = React.useState(createWorkspaceBarGeometry);
    const paneRefs = React.useRef<Record<string, View | null>>({});
    const dispatch = React.useCallback((action: Parameters<typeof reduceWorkspaceState>[1]) => setState((current) => reduceWorkspaceState(current, action)), []);
    React.useEffect(() => { setState(fixtureState(frame)); }, [frame]);
    React.useEffect(() => {
        const before = storage.getState().sessionListRowsByServerId[HOME];
        const seeded = fixtureRows();
        storage.setState((current) => ({ sessionListRowsByServerId: { ...current.sessionListRowsByServerId, [HOME]: seeded } }));
        return () => storage.setState((current) => {
            const rows = { ...current.sessionListRowsByServerId };
            if (before) rows[HOME] = before; else delete rows[HOME];
            return { sessionListRowsByServerId: rows };
        });
    }, []);
    const value = React.useMemo((): WorkspaceNavigationContextValue => ({
        active: true, state, canGoBack: false, canGoForward: false,
        dispatch, openHref: () => false,
        activateTab: (groupId, tabId) => dispatch({ type: 'activateTab', groupId, tabId }),
        closeTab: (groupId, tabId) => dispatch({ type: 'closeTab', groupId, tabId, newTab: createWorkspaceEmptyTab('empty') }),
        closeTabs: (groupId, tabIds) => {
            for (const tabId of tabIds) if (!state.tabs[tabId]?.pinned) {
                dispatch({ type: 'closeTab', groupId, tabId, newTab: createWorkspaceEmptyTab('empty') });
            }
        },
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    }), [dispatch, state]);
    const measure = (groupId: string) => paneRefs.current[groupId]?.measureInWindow?.((x, _y, width) => geometry.setGroupFrame(groupId, { x, width }));
    const changeStatus = () => storage.setState((current) => ({ sessionListRowsByServerId: {
        ...current.sessionListRowsByServerId, [HOME]: { ...current.sessionListRowsByServerId[HOME], fix: sessionRow('fix', 'attention') },
    } }));
    return <WorkspaceNavigationContext.Provider value={value}>
        <WorkspaceBarGeometryContext.Provider value={geometry}>
            <View style={styles.root} testID="workspace-specimen-current-source">
                <View style={styles.strip}>
                    <WorkspaceTitleBar catalog={catalog} clusterEndPx={0} stripHeightPx={44} />
                </View>
                <View style={styles.panes}>
                    {Object.values(state.groups).map((group) => <View
                        key={group.id} ref={(view) => { paneRefs.current[group.id] = view; }}
                        onLayout={() => measure(group.id)} style={styles.pane} testID={`workspace-specimen-pane-${group.id}`}
                    >
                        <ChatHeaderView title={TITLES[group.activeTabId] ?? group.activeTabId} subtitle="happier · Studio" showBackButton={false} includeTopInset={false} />
                        <View style={styles.body}>
                            <Text style={styles.copy}>It remounts because the modal key includes the window width, so every resize throws its state away.</Text>
                            <Text style={styles.copy}>The tab strip uses the live session projection above. Close a tab, then reopen its original instance from Recently closed.</Text>
                        </View>
                    </View>)}
                </View>
                <View style={styles.tools}>
                    <IconButton testID="workspace-specimen-status-update" iconName="bell" accessibilityLabel={t('workspaceBar.tabsLabel')} onPress={changeStatus} variant="plain" />
                    <IconButton testID="workspace-specimen-reset" iconName="arrow-clockwise" accessibilityLabel={t('common.reset')} onPress={() => setState(fixtureState(frame))} variant="plain" />
                    <Text testID="workspace-specimen-order" style={styles.diagnostic}>{JSON.stringify(Object.values(state.groups).map((group) => ({ id: group.id, tabs: group.tabIds })))}</Text>
                </View>
            </View>
        </WorkspaceBarGeometryContext.Provider>
    </WorkspaceNavigationContext.Provider>;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
    strip: { height: 44, backgroundColor: theme.colors.surface.inset },
    panes: { flex: 1, flexDirection: 'row' },
    pane: { flex: 1, minWidth: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.border.subtle },
    body: { padding: 24, gap: 16 },
    copy: { fontSize: 15, lineHeight: 23, color: theme.colors.text.primary, ...Typography.default() },
    tools: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.subtle },
    diagnostic: { fontSize: 11, color: theme.colors.text.secondary, ...Typography.default() },
}));
