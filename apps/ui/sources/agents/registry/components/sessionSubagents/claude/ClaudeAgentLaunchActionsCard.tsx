import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionSubagentLaunchCardShell } from '@/components/sessions/agents/launch/SessionSubagentLaunchCardShell';
import { Text } from '@/components/ui/text/Text';
import type { Theme } from '@/theme';
import { t } from '@/text';
import { createClaudeSubagentLauncherDetailsTab } from './createClaudeSubagentLauncherDetailsTab';

const stylesheet = StyleSheet.create((theme: Theme) => ({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    button: {
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    buttonText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        fontWeight: '600',
    },
}));

export const ClaudeAgentLaunchActionsCard = React.memo((props: Readonly<{
    scopeId: string;
    teamIds: readonly string[];
}>) => {
    const styles = stylesheet;
    const pane = useAppPaneScope(props.scopeId);
    const firstTeamId = props.teamIds[0] ?? null;

    const openTeamLauncher = React.useCallback(() => {
        pane.openDetailsTab(createClaudeSubagentLauncherDetailsTab('team'), { intent: 'preview' });
    }, [pane]);

    const openTeammateLauncher = React.useCallback(() => {
        pane.openDetailsTab(createClaudeSubagentLauncherDetailsTab('member', firstTeamId), { intent: 'preview' });
    }, [firstTeamId, pane]);

    return (
        <SessionSubagentLaunchCardShell
            testID="session-subagent-launch-claude-card"
            title={t('session.subagents.panel.launchClaudeTeamsTitle')}
            subtitle={t('session.subagents.panel.launchClaudeTeamsSubtitle')}
        >
            <View style={styles.row}>
                <Pressable
                    testID="session-subagent-launch-claude-team"
                    accessibilityRole="button"
                    accessibilityLabel={t('session.subagents.panel.launchClaudeTeamA11y')}
                    onPress={openTeamLauncher}
                    style={({ pressed }) => [styles.button, { opacity: pressed ? 0.7 : 1 }]}
                >
                    <Text style={styles.buttonText}>{t('session.subagents.panel.launchClaudeTeamAction')}</Text>
                </Pressable>
                <Pressable
                    testID="session-subagent-launch-claude-teammate"
                    accessibilityRole="button"
                    accessibilityLabel={t('session.subagents.panel.launchTeammateA11y')}
                    onPress={openTeammateLauncher}
                    style={({ pressed }) => [styles.button, { opacity: pressed ? 0.7 : 1 }]}
                >
                    <Text style={styles.buttonText}>{t('session.subagents.panel.launchTeammateAction')}</Text>
                </Pressable>
            </View>
        </SessionSubagentLaunchCardShell>
    );
});
