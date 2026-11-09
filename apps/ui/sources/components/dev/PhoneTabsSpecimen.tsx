import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { PhoneOpenTabsRail } from '@/components/appShell/workspace/PhoneOpenTabsRail';
import {
    useOptionalWorkspaceNavigation,
    WorkspaceNavigationProvider,
    type WorkspaceNavigationContextValue,
} from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState, type WorkspaceTab } from '@/components/appShell/workspace/workspaceState';
import { SessionPaneHeader } from '@/components/sessions/shell/view/SessionPaneHeader';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Dev-only: the phone's open-tabs rail (phone-nav lab R, K) on representative synced tabs — a pinned
 * page, a desktop split, sessions, a board, a settings page, a tab this phone cannot show and the
 * phone's preview — so the build can be paired against the lab without a second device writing the
 * account's tab set. The real rail, pager and header render against a fixture of the real owner state.
 */

type Frame = 'rail' | 'preview' | 'unavailable';

const tab = (id: string, kind: string, params: Record<string, string>, extra: Partial<WorkspaceTab> = {}): WorkspaceTab => ({
    id, target: { kind, params }, pinned: false, preview: false, ...extra,
});

function buildState(frame: Frame): WorkspaceState {
    const tabs: Array<[WorkspaceTab, string]> = [
        [tab('workflows', 'workflows', {}, { pinned: true }), 'Workflows'],
        [tab('fix', 'session', { id: 'specimen-fix' }), 'Fix settings modal remount'],
        [tab('fixDiff', 'sessionDetails', { id: 'specimen-fix', details: 'file', path: 'apps/ui/SettingsModal.tsx' }), 'SettingsModal.tsx'],
        [tab('review', 'session', { id: 'specimen-review' }), 'Review #2481'],
        [tab('board', 'boards', {}), 'Release board'],
        [tab('term', 'terminal:studio', { machine: 'studio' }), 'zsh · Studio'],
        [tab('appearance', 'settings', { pageId: 'appearance' }), 'Appearance'],
    ];
    let state = createWorkspaceState(tabs[0][0]);
    for (const [item, title] of tabs) {
        if (item.id !== 'workflows') state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: item });
        state = reduceWorkspaceState(state, { type: 'setFallbackTitle', tabId: item.id, title });
    }
    if (frame === 'preview') {
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('relay', 'session', { id: 'specimen-relay' }, { preview: true }) });
        state = reduceWorkspaceState(state, { type: 'setFallbackTitle', tabId: 'relay', title: 'Relay retries spike' });
    }
    const active = frame === 'preview' ? 'relay' : frame === 'unavailable' ? 'term' : 'fix';
    state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: active });
    return { ...state, tabPairs: [['fix', 'fixDiff']] };
}

const HEADERS: Record<Frame, { title: string; subtitle: string }> = {
    rail: { title: 'Fix settings modal remount', subtitle: 'Split · 2 panes' },
    preview: { title: 'Relay retries spike', subtitle: 'Claude · devbox' },
    unavailable: { title: 'zsh · Studio', subtitle: 'Terminal · Studio' },
};

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
    body: { paddingHorizontal: theme.space.s20, paddingTop: theme.space.s12, gap: 14 },
    copy: { fontSize: 16, lineHeight: 23, color: theme.colors.text.primary, ...Typography.default() },
}));

export function PhoneTabsSpecimen(props: Readonly<{ frame: string | null }>) {
    const frame: Frame = props.frame === 'preview' || props.frame === 'unavailable' ? props.frame : 'rail';
    const catalog = useCompactAppDestinations();
    const outer = useOptionalWorkspaceNavigation();
    const [state, setState] = React.useState(() => buildState(frame));
    React.useEffect(() => { setState(buildState(frame)); }, [frame]);
    const value = React.useMemo((): WorkspaceNavigationContextValue | null => (outer ? {
        ...outer,
        state,
        tabSyncStatus: 'synced',
        phone: {
            catalog,
            onTab: true,
            openHref: () => false,
            // Showing a tab or pane on the specimen only moves its local focus; nothing is written.
            activateTab: (tabId) => setState((current) => reduceWorkspaceState(current, { type: 'activateTab', groupId: 'group:1', tabId })),
            closeTab: () => {},
        },
    } : null), [catalog, outer, state]);
    if (!value) return null;
    const header = HEADERS[frame];
    return (
        <WorkspaceNavigationProvider value={value}>
            <View style={styles.root}>
                <SessionPaneHeader title={header.title} subtitle={header.subtitle} onBackPress={() => {}} />
                <PhoneOpenTabsRail />
                <ScrollView contentContainerStyle={styles.body}>
                    <Text style={styles.copy}>{frame === 'unavailable'
                        ? 'Tap the dimmed tab: this phone cannot show it, so it offers to close it.'
                        : 'It remounts because SettingsModal’s key includes the window width, so every resize throws its state away.'}</Text>
                </ScrollView>
            </View>
        </WorkspaceNavigationProvider>
    );
}
