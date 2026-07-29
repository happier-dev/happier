import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { RightSidebarIconTabBar } from '@/components/appShell/rightSidebar/RightSidebarIconTabBar';
import {
    resolveRightSidebarActiveTab,
    resolveSessionRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { SessionRightPanelAgentsView } from '@/components/sessions/panes/agents/SessionRightPanelAgentsView';
import { SessionTranscriptNavigationPane } from '@/components/sessions/panes/SessionTranscriptNavigationPane';
import { t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { SessionRightPanelBrowserView } from './browser/SessionRightPanelBrowserView';
import { SessionRightPanelServicesView } from './services/SessionRightPanelServicesView';
import { SessionBrowseFilesSurface } from './surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from './surfaces/SessionGitSurface';
import { SessionTerminalSurface } from './surfaces/SessionTerminalSurface';
import { useSessionFileDetailsOpener } from './useSessionFileDetailsOpener';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

export type SessionRightPanelProps = Readonly<{
    sessionId: string;
    scopeId: string;
    presentation?: 'pane' | 'screen';
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the
     * same surface as the desktop right pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
}>;

type RightTabId = string;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        minHeight: 0,
        minWidth: 0,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
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
    tabBarContainer: {
        flex: 1,
        alignItems: 'center',
    },
    closeButton: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
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
    const insets = useChromeSafeAreaInsets();
    const pane = useAppPaneScope(props.scopeId);
    const scopeState = pane.scopeState;
    const headerPaddingTop = 10;
    const { sidebarTabAvailable: terminalTabAvailable } = useSessionTerminalAvailability();
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const closeButtonAtStart = props.presentation === 'screen' && Platform.OS !== 'web';
    const headerSafeAreaTop = closeButtonAtStart ? 0 : insets.top;
    const sessionMachineTarget = useSessionMachineTarget(props.sessionId);
    const servicesServerId = usePreferredServerIdForSession(props.sessionId);
    const pluginProjection = useScopedPluginUiProjection({
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId: servicesServerId,
    });
    const pluginRightSidebarPlacements = React.useMemo(() => (
        pluginProjection.pluginUiProjection
            ? selectPluginRightSidebarTabPlacements(pluginProjection.pluginUiProjection, 'session')
            : []
    ), [pluginProjection.pluginUiProjection]);
    const rightPanelTabs = React.useMemo(() => resolveSessionRightSidebarTabs({
        terminalTabAvailable,
        presentation: props.presentation === 'screen' ? 'mobile' : 'desktop',
        pluginPlacements: pluginRightSidebarPlacements,
        projectionGeneration: pluginProjection.pluginUiProjection?.generation ?? null,
    }), [pluginProjection.pluginUiProjection?.generation, pluginRightSidebarPlacements, props.presentation, terminalTabAvailable]);
    const activeTab = resolveRightSidebarActiveTab<RightTabId>(
        scopeState?.right.activeTabId,
        rightPanelTabs,
    );

    const setActiveTab = React.useCallback((tabId: RightTabId) => {
        pane.openRight({ tabId });
        pane.setRightTab(tabId);
    }, [pane]);

    React.useEffect(() => {
        if (!scopeState?.right.isOpen) return;
        if (scopeState.right.activeTabId !== activeTab) {
            pane.setRightTab(activeTab);
        }
    }, [activeTab, pane, scopeState?.right.activeTabId, scopeState?.right.isOpen]);

    const closeNavigationPane = props.onRequestClose ?? pane.closeRight;
    // On `screen` presentation this panel IS a route of its own and the transcript lives on
    // another one, so a navigation jump has to bring the transcript back before it can land.
    // Beside a mounted transcript (the desktop pane) there is nothing to reveal, and closing
    // the pane on every jump would throw the reader's navigation list away.
    const revealTranscriptForNavigationJump = props.presentation === 'screen'
        ? closeNavigationPane
        : undefined;

    const { openFileInDetails, openFileInDetailsPinned } = useSessionFileDetailsOpener(props.scopeId);
    const availableTabIds = React.useMemo(() => new Set(rightPanelTabs.map((tab) => tab.id)), [rightPanelTabs]);

    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: props.scopeId,
        scope: 'sessionDetails',
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId: servicesServerId,
        sessionId: props.sessionId,
    });

    const closeButton = (
        <Pressable
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-close')}
            onPress={props.onRequestClose ?? pane.closeRight}
            style={closeButtonAtStart ? undefined : styles.closeButton}
            hitSlop={closeButtonAtStart ? 15 : undefined}
            accessibilityRole="button"
            accessibilityLabel={closeButtonAtStart ? t('common.back') : t('common.close')}
        >
            {closeButtonAtStart ? (
                <SafeIonicons
                    name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                    size={24}
                    color={theme.colors.chrome.header.foreground}
                />
            ) : (
                <Octicons name="x" size={18} color={theme.colors.text.secondary} />
            )}
        </Pressable>
    );

    return (
        <View testID="session-right-panel-root" style={styles.container}>
            <View style={[styles.header, { paddingTop: headerPaddingTop + headerSafeAreaTop }]}>
                {closeButtonAtStart ? closeButton : null}
                <View style={styles.tabBarContainer}>
                    <RightSidebarIconTabBar
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
                    <RetainedPanelSurface
                        isActive={activeTab === 'git'}
                        mode="absolute-overlay"
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-git')}
                    >
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                            <SessionGitSurface sessionId={props.sessionId} scopeId={props.scopeId} />
                        </React.Suspense>
                    </RetainedPanelSurface>
                    <RetainedPanelSurface
                        isActive={activeTab === 'files'}
                        mode="absolute-overlay"
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-files')}
                    >
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                            <SessionBrowseFilesSurface
                                sessionId={props.sessionId}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                            />
                        </React.Suspense>
                    </RetainedPanelSurface>
                    <RetainedPanelSurface
                        isActive={activeTab === 'agents'}
                        mode="absolute-overlay"
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-agents')}
                    >
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                            <SessionRightPanelAgentsView sessionId={props.sessionId} scopeId={props.scopeId} />
                        </React.Suspense>
                    </RetainedPanelSurface>
                    <RetainedPanelSurface
                        isActive={activeTab === 'navigation'}
                        mode="absolute-overlay"
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-navigation')}
                    >
                        <SessionTranscriptNavigationPane
                            onRequestClose={closeNavigationPane}
                            onRevealTranscript={revealTranscriptForNavigationJump}
                            sessionId={props.sessionId}
                            testIDPrefix="session-transcript-navigation"
                        />
                    </RetainedPanelSurface>
                    {availableTabIds.has('terminal') && (
                        <RetainedPanelSurface
                            isActive={activeTab === 'terminal'}
                            mode="absolute-overlay"
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-terminal')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                <SessionTerminalSurface sessionId={props.sessionId} scopeId={props.scopeId} />
                            </React.Suspense>
                        </RetainedPanelSurface>
                    )}
                    {availableTabIds.has('browser') && (
                        <RetainedPanelSurface
                            isActive={activeTab === 'browser'}
                            mode="absolute-overlay"
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-browser')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                <SessionRightPanelBrowserView sessionId={props.sessionId} />
                            </React.Suspense>
                        </RetainedPanelSurface>
                    )}
                    {availableTabIds.has('services') && (
                        <RetainedPanelSurface
                            isActive={activeTab === 'services'}
                            mode="absolute-overlay"
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-services')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                <SessionRightPanelServicesView
                                    sessionId={props.sessionId}
                                    onOpenServiceInBrowser={openServiceInBrowser}
                                />
                            </React.Suspense>
                        </RetainedPanelSurface>
                    )}
                    {rightPanelTabs
                        .filter((tab): tab is RightSidebarPluginTabDefinition => tab.owner === 'plugin')
                        .map((tab) => tab.disabledReason ? null : (
                            <RetainedPanelSurface
                                key={tab.retentionKey}
                                isActive={activeTab === tab.id}
                                mode="absolute-overlay"
                                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-rightpanel-surface-${tab.id}`)}
                            >
                                <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.text.secondary} />}>
                                    <PluginSurfacePlacementHost
                                        placement={tab.placement}
                                        machineId={pluginProjection.machineId}
                                        serverId={pluginProjection.serverId}
                                        pluginUiProjection={pluginProjection.pluginUiProjection}
                                        projectionInteractionEnabled={pluginProjection.interactionEnabled}
                                        platform={pluginProjection.platform}
                                    />
                                </React.Suspense>
                            </RetainedPanelSurface>
                        ))}
                </View>
            </View>
        </View>
    );
});
