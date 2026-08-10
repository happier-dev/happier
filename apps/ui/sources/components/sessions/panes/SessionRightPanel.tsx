import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FrozenSubtree } from '@/components/ui/performance/FrozenSubtree';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { IconAction } from '@/components/ui/buttons/IconAction';
import { SegmentedTabBar, SEGMENTED_TAB_ICON_SIZE_PX, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionRightPanelAgentsView } from '@/components/sessions/panes/agents/SessionRightPanelAgentsView';
import { SessionBrowseFilesSurface } from '@/components/sessions/panes/surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from '@/components/sessions/panes/surfaces/SessionGitSurface';
import { SessionTerminalSurface } from '@/components/sessions/panes/surfaces/SessionTerminalSurface';
import { SessionTranscriptNavigationPane } from '@/components/sessions/panes/SessionTranscriptNavigationPane';
import { useSessionFileDetailsOpener } from '@/components/sessions/panes/useSessionFileDetailsOpener';
import { useSessionSubagentCounts } from '@/hooks/session/useSessionSubagentCounts';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export type SessionRightPanelProps = Readonly<{
    sessionId: string;
    scopeId: string;
    serverId?: string | null;
    presentation?: 'pane' | 'screen';
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the
     * same surface as the desktop right pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
}>;

type RightTabId = 'git' | 'files' | 'navigation' | 'agents' | 'terminal';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        minHeight: 0,
        minWidth: 0,
        // No top border. The dock already separates this pane from the main content with its own
        // seam, so this line only ran along the window's top edge and doubled the chrome.
    },
    header: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    segmentedContainer: {
        flex: 1,
    },
    body: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
}));

export const SessionRightPanel = React.memo((props: SessionRightPanelProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const scopeState = pane.scopeState;
    const { openFileInDetails, openFileInDetailsPinned } = useSessionFileDetailsOpener(props.scopeId);

    const terminalAvailability = useSessionTerminalAvailability({
        sessionId: props.sessionId,
        serverId: props.serverId ?? null,
    });
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    // The Agents tab is the one tab whose contents can change while you are looking at another tab,
    // so it is the one tab that needs to say so from the bar. The count comes from the session's
    // subagent owner, not from a second tally.
    const runningAgentCount = useSessionSubagentCounts(props.sessionId).active;
    const terminalTabAvailable = terminalAvailability.sidebarTabAvailable;
    const closeButtonAtStart = props.presentation === 'screen' && Platform.OS !== 'web';
    const rawActiveTab = (scopeState?.right.activeTabId as RightTabId | null) ?? 'git';
    const activeTab: RightTabId =
        rawActiveTab === 'terminal' && !terminalTabAvailable
            ? 'git'
            : rawActiveTab;

    const setActiveTab = React.useCallback((tabId: RightTabId) => {
        pane.openRight({ tabId });
        pane.setRightTab(tabId);
    }, [pane]);

    React.useEffect(() => {
        if (!scopeState?.right.isOpen) return;
        if (!scopeState.right.activeTabId) {
            pane.setRightTab('git');
        }
        if (scopeState.right.activeTabId === 'terminal' && !terminalTabAvailable) {
            pane.setRightTab('git');
        }
    }, [pane, scopeState?.right.activeTabId, scopeState?.right.isOpen, terminalTabAvailable]);

    const rightPanelTabs = React.useMemo((): ReadonlyArray<SegmentedTab<RightTabId>> => {
        // Icons, not words. Four labels cost a full text row in a pane this narrow, and the
        // labels survive as the accessible name and the hover tooltip.
        const glyph = (name: IconName) => (
            <Icon name={name} size={SEGMENTED_TAB_ICON_SIZE_PX} color={theme.colors.text.secondary} />
        );
        const base: SegmentedTab<RightTabId>[] = [
            { id: 'git', label: t('session.rightPanel.tabs.git'), icon: glyph('git-branch') },
            { id: 'files', label: t('common.files'), icon: glyph('folder') },
            { id: 'navigation', label: t('session.transcriptNavigation.title'), icon: glyph('list-bullets') },
            {
                id: 'agents',
                label: t('session.subagents.panel.title'),
                icon: glyph('robot'),
                // Running agents only. A tab badge is a live indicator, and a session that finished
                // an agent an hour ago has nothing for the user to go and look at — the same rule
                // the session header's agent count already follows.
                badgeCount: runningAgentCount,
                accessibilityLabel: runningAgentCount > 0
                    ? t('session.subagents.panel.tabWithRunningCount', { count: runningAgentCount })
                    : undefined,
            },
        ];
        if (terminalTabAvailable) {
            base.push({ id: 'terminal', label: t('settings.terminal'), icon: glyph('terminal') });
        }
        return base;
    }, [runningAgentCount, terminalTabAvailable, theme.colors.text.secondary]);

    const closeButton = (
        <IconAction
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-close')}
            onPress={props.onRequestClose ?? pane.closeRight}
            accessibilityLabel={closeButtonAtStart ? t('common.back') : t('common.close')}
        >
            <Icon name={closeButtonAtStart ? 'caret-left' : 'x'} size={16} color={theme.colors.text.secondary} />
        </IconAction>
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                {closeButtonAtStart ? closeButton : null}
                <View style={styles.segmentedContainer}>
                    <SegmentedTabBar
                        tabs={rightPanelTabs}
                        activeTabId={activeTab}
                        onSelectTab={setActiveTab}
                        testIDPrefix={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-tab') ?? undefined}
                    />
                </View>
                {closeButtonAtStart ? null : closeButton}
            </View>
            <View style={styles.body}>
                <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                    <RightTabSurface
                        isActive={activeTab === 'git'}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-git')}
                    >
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                            <SessionGitSurface sessionId={props.sessionId} scopeId={props.scopeId} />
                        </React.Suspense>
                    </RightTabSurface>
                    <RightTabSurface
                        isActive={activeTab === 'files'}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-files')}
                    >
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                            <SessionBrowseFilesSurface
                                sessionId={props.sessionId}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                            />
                        </React.Suspense>
                    </RightTabSurface>
                    <RightTabSurface
                        isActive={activeTab === 'navigation'}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-navigation')}
                    >
                        <SessionTranscriptNavigationPane
                            onRequestClose={props.onRequestClose ?? pane.closeRight}
                            sessionId={props.sessionId}
                            testIDPrefix="session-transcript-navigation"
                        />
                    </RightTabSurface>
                    <RightTabSurface
                        isActive={activeTab === 'agents'}
                        // The roster subscribes to session state and re-derives the whole agent list
                        // from it. Left running behind another tab it re-derives on every transcript
                        // update for the rest of the session's life, so this surface freezes instead.
                        inactiveRetention="suspended"
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-agents')}
                    >
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                            <SessionRightPanelAgentsView sessionId={props.sessionId} scopeId={props.scopeId} />
                        </React.Suspense>
                    </RightTabSurface>
                    {terminalTabAvailable && (
                        <RightTabSurface
                            isActive={activeTab === 'terminal'}
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-terminal')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                <SessionTerminalSurface sessionId={props.sessionId} scopeId={props.scopeId} />
                            </React.Suspense>
                        </RightTabSurface>
                    )}
                </View>
            </View>
        </View>
    );
});

const PaneLoadingFallback = React.memo((props: Readonly<{ color: string }>) => {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingHorizontal: 16 }}>
            <ActivitySpinner size="small" color={props.color} />
            <Text style={{ marginTop: 10, fontSize: 12, color: props.color, ...Typography.default() }}>
                {t('common.loading')}
            </Text>
        </View>
    );
});

/**
 * What an inactive tab is allowed to keep doing.
 *
 * `'live'` is the historical behaviour: the surface stays mounted and keeps working off every store
 * update it subscribes to. That is correct for a surface that owns something running — the embedded
 * terminal has to stay attached to its session whether or not you are looking at it.
 *
 * `'suspended'` keeps the surface mounted but stops it rendering (`FrozenSubtree`). Its state, and
 * therefore its scroll position and hydrated content, survive; only the work stops. Choose it for a
 * surface that merely projects session state, where re-deriving behind another tab is pure waste.
 */
type RightTabInactiveRetention = 'live' | 'suspended';

const RightTabSurface = React.memo((props: Readonly<{
    isActive: boolean;
    inactiveRetention?: RightTabInactiveRetention;
    testID?: string;
    children: React.ReactNode;
}>) => {
    const active = props.isActive;
    const [hasMounted, setHasMounted] = React.useState(active);

    React.useLayoutEffect(() => {
        if (active) setHasMounted(true);
    }, [active]);

    if (!active && !hasMounted) return null;

    // Web already drops an inactive surface out of layout with `display:'none'`; native keeps it in
    // layout at `opacity:0`, so this is where the retained cost actually lives. Keeping the web path
    // byte-identical also keeps its Suspense boundaries where they are today.
    const suspendInactive = props.inactiveRetention === 'suspended' && Platform.OS !== 'web';

    return (
        <View
            testID={props.testID}
            pointerEvents={active ? 'auto' : 'none'}
            style={[
                StyleSheet.absoluteFillObject,
                {
                    opacity: active ? 1 : 0,
                    display: Platform.OS === 'web' ? (active ? 'flex' : 'none') : 'flex',
                },
            ]}
        >
            {suspendInactive
                ? <FrozenSubtree frozen={!active}>{props.children}</FrozenSubtree>
                : props.children}
        </View>
    );
});
