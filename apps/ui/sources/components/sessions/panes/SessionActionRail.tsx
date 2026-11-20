import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PANE_ACTION_RAIL_WIDTH, usePaneActionRailRightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { IconAction } from '@/components/ui/buttons/IconAction';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { useSessionTerminalAction } from '@/components/sessions/terminal/useSessionTerminalAction';
import { t } from '@/text';

import { SESSION_DETAILS_SCM_REVIEW_TAB_KEY } from './details/sessionDetailsTabBuilders';
import { getSessionRightPanelTabs } from './sessionRightPanelTabs';
import { selectSessionRightTab, toggleSessionReview } from './sessionPaneActions';
import { SessionGitActionRailBadge, SessionGitActionRailTooltip } from './SessionGitActionRailBadge';
import { useSessionGitActionRailBadge } from './SessionGitActionRailBadge';
import { formatGitActionRailAccessibilityLabel } from '@/components/ui/navigation/tabBadge/gitActionRailAccessibility';
import { useSessionRunningAgentCount } from './useSessionRunningAgentCount';
import { useOpenSessionTarget } from './open/useOpenSessionTarget';

const styles = StyleSheet.create((theme) => ({
    rail: {
        width: PANE_ACTION_RAIL_WIDTH,
        flexGrow: 0,
        flexShrink: 0,
        minHeight: 0,
    },
    activeMarker: {
        position: 'absolute',
        left: -9,
        top: 0,
        bottom: 0,
        width: 2,
        borderRadius: 1,
        backgroundColor: theme.colors.text.primary,
    },
    actions: { alignItems: 'center', paddingVertical: 4, gap: 4 },
    action: {
        width: Platform.OS === 'web' ? 36 : Platform.OS === 'android' ? 48 : 44,
        height: Platform.OS === 'web' ? 36 : Platform.OS === 'android' ? 48 : 44,
    },
}));

export const SessionActionRail = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
    serverId?: string | null;
}>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    const terminal = useSessionTerminalAction(props);
    const openSessionTarget = useOpenSessionTarget({ sessionId: props.sessionId, scopeId: props.scopeId, serverId: props.serverId });
    const runningAgentCount = useSessionRunningAgentCount(props.sessionId);
    const gitBadge = useSessionGitActionRailBadge(props.sessionId);
    const tabs = getSessionRightPanelTabs(false, runningAgentCount);
    const reviewActive = Boolean(pane.scopeState?.details.isOpen && pane.scopeState.details.activeTabKey === SESSION_DETAILS_SCM_REVIEW_TAB_KEY);

    const renderAction = (action: Readonly<{
        id: string;
        label: string;
        icon: IconName;
        active: boolean;
        onPress: () => void;
        badgeCount?: number;
    }>) => (
        <IconAction
            key={action.id}
            testID={`session-action-rail:${action.id}`}
            tooltipPlacement="left"
            tooltipContent={action.id === 'git' ? <SessionGitActionRailTooltip sessionId={props.sessionId} /> : undefined}
            accessibilityLabel={action.id === 'git' ? formatGitActionRailAccessibilityLabel(gitBadge, {
                actionLabel: action.label,
                changedFilesLabel: t('settingsAppearance.tabBarBadges.gitChangedFiles'),
                diffLinesLabel: t('settingsAppearance.tabBarBadges.gitDiffLines'),
            }) : action.label}
            accessibilityState={{ selected: action.active }}
            onPress={action.onPress}
            style={styles.action}
        >
            <View>
                {action.active ? <View style={styles.activeMarker} /> : null}
                <Icon name={action.icon} size={18} color={action.active ? theme.colors.text.primary : theme.colors.text.secondary} />
                {action.id === 'git' ? <SessionGitActionRailBadge badge={gitBadge} /> : null}
                {(action.badgeCount ?? 0) > 0 ? (
                    <TabBadge size="compact" variant="count" value={action.badgeCount ?? 0} tone="neutral" testID={`session-action-rail:${action.id}:badge`} />
                ) : null}
            </View>
        </IconAction>
    );

    return (
        <ScrollView accessibilityRole="toolbar" accessibilityLabel={t('common.actions')} testID="session-action-rail" style={styles.rail} contentContainerStyle={styles.actions} showsVerticalScrollIndicator={false}>
            {tabs.map((tab) => (
                <React.Fragment key={tab.id}>
                    {renderAction({
                        id: tab.id,
                        label: tab.accessibilityLabel ?? tab.label,
                        icon: tab.icon,
                        active: !rightPaneHiddenByDetails && Boolean(pane.scopeState?.right.isOpen && (pane.scopeState.right.activeTabId ?? 'git') === tab.id),
                        onPress: () => selectSessionRightTab(pane, tab.id, rightPaneHiddenByDetails),
                        badgeCount: tab.badgeCount,
                    })}
                    {tab.id === 'git' ? renderAction({
                        id: 'review', label: t('files.toolbar.review'), icon: 'file-diff',
                        active: reviewActive, onPress: () => toggleSessionReview(pane),
                    }) : null}
                    {/* Opens Files directly on its Session media tab; the Files button above keeps its own toggle. */}
                    {tab.id === 'files' ? renderAction({
                        id: 'media', label: t('files.sessionMedia.title'), icon: 'image',
                        active: false, onPress: () => { openSessionTarget({ kind: 'fileBrowser', view: 'session' }); },
                    }) : null}
                </React.Fragment>
            ))}
            {terminal.available ? renderAction({
                id: 'terminal', label: t('settings.terminal'), icon: 'terminal',
                active: terminal.active, onPress: terminal.onPress,
            }) : null}
        </ScrollView>
    );
});
