import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { SessionRightPanelAgentsView } from '@/components/sessions/panes/agents/SessionRightPanelAgentsView';
import { t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { SessionBrowseFilesSurface } from './surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from './surfaces/SessionGitSurface';
import { SessionTerminalSurface } from './surfaces/SessionTerminalSurface';
import { useSessionFileDetailsOpener } from './useSessionFileDetailsOpener';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';

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

type RightTabId = 'git' | 'files' | 'agents' | 'terminal';

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
    segmentedContainer: {
        flex: 1,
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

    const { openFileInDetails, openFileInDetailsPinned } = useSessionFileDetailsOpener(props.scopeId);

    const rightPanelTabs = React.useMemo((): ReadonlyArray<SegmentedTab<RightTabId>> => {
        const base: SegmentedTab<RightTabId>[] = [
            { id: 'git', label: t('session.rightPanel.tabs.git') },
            { id: 'files', label: t('common.files') },
            { id: 'agents', label: t('session.subagents.panel.title') },
        ];
        if (terminalTabAvailable) {
            base.push({ id: 'terminal', label: t('settings.terminal') });
        }
        return base;
    }, [terminalTabAvailable]);

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
                    {terminalTabAvailable && (
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
                </View>
            </View>
        </View>
    );
});
