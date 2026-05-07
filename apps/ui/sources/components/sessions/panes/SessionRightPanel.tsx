import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionRightPanelAgentsView } from '@/components/sessions/panes/agents/SessionRightPanelAgentsView';
import { SessionBrowseFilesSurface } from '@/components/sessions/panes/surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from '@/components/sessions/panes/surfaces/SessionGitSurface';
import { SessionTerminalSurface } from '@/components/sessions/panes/surfaces/SessionTerminalSurface';
import { useSessionFileDetailsOpener } from '@/components/sessions/panes/useSessionFileDetailsOpener';
import { useSessionTerminalAvailability } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';

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

type RightTabId = 'git' | 'files' | 'agents' | 'terminal';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        minHeight: 0,
        minWidth: 0,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.divider,
    },
    header: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
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
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
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
            style={styles.closeButton}
            accessibilityRole="button"
            accessibilityLabel={closeButtonAtStart ? t('common.back') : t('common.close')}
        >
            <Octicons name={closeButtonAtStart ? 'chevron-left' : 'x'} size={18} color={theme.colors.textSecondary} />
        </Pressable>
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
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.textSecondary} />}>
                            <SessionGitSurface sessionId={props.sessionId} scopeId={props.scopeId} />
                        </React.Suspense>
                    </RightTabSurface>
                    <RightTabSurface
                        isActive={activeTab === 'files'}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-files')}
                    >
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.textSecondary} />}>
                            <SessionBrowseFilesSurface
                                sessionId={props.sessionId}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                            />
                        </React.Suspense>
                    </RightTabSurface>
                    <RightTabSurface
                        isActive={activeTab === 'agents'}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-agents')}
                    >
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.textSecondary} />}>
                            <SessionRightPanelAgentsView sessionId={props.sessionId} scopeId={props.scopeId} />
                        </React.Suspense>
                    </RightTabSurface>
                    {terminalTabAvailable && (
                        <RightTabSurface
                            isActive={activeTab === 'terminal'}
                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-rightpanel-surface-terminal')}
                        >
                            <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.textSecondary} />}>
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
            <ActivityIndicator size="small" color={props.color} />
            <Text style={{ marginTop: 10, fontSize: 12, color: props.color, ...Typography.default() }}>
                {t('common.loading')}
            </Text>
        </View>
    );
});

const RightTabSurface = React.memo((props: Readonly<{ isActive: boolean; testID?: string; children: React.ReactNode }>) => {
    const active = props.isActive;
    const [hasMounted, setHasMounted] = React.useState(active);

    React.useLayoutEffect(() => {
        if (active) setHasMounted(true);
    }, [active]);

    if (!active && !hasMounted) return null;
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
            {props.children}
        </View>
    );
});
