import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionSubagentLaunchCardShell } from '@/components/sessions/agents/launch/SessionSubagentLaunchCardShell';
import { createExecutionRunLauncherDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
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
    secondaryText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '500',
    },
}));

const EXECUTION_RUN_INTENTS = ['review', 'plan', 'delegate'] as const;
const EXECUTION_RUN_INTENT_LABEL_KEYS = {
    review: 'executionRuns.newRun.intents.review',
    plan: 'executionRuns.newRun.intents.plan',
    delegate: 'executionRuns.newRun.intents.delegate',
} as const;

type ExecutionRunIntent = (typeof EXECUTION_RUN_INTENTS)[number];

export const ExecutionRunLaunchCard = React.memo((props: Readonly<{ sessionId: string; scopeId: string }>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);

    const openNewRun = React.useCallback((intent?: ExecutionRunIntent) => {
        pane.openDetailsTab(createExecutionRunLauncherDetailsTab(intent), { intent: 'preview' });
    }, [pane]);

    return (
        <SessionSubagentLaunchCardShell
            testID="session-subagent-launch-execution-run"
            title={t('session.subagents.panel.launchExecutionRunsTitle')}
            subtitle={t('session.subagents.panel.launchExecutionRunsSubtitle')}
        >
            <View style={styles.row}>
                {EXECUTION_RUN_INTENTS.map((intent) => (
                    <Pressable
                        key={intent}
                        testID={`session-subagent-launch-execution-run:${intent}`}
                        accessibilityRole="button"
                        accessibilityLabel={t('executionRuns.newRun.a11y.selectIntent', {
                            intent: t(EXECUTION_RUN_INTENT_LABEL_KEYS[intent]),
                        })}
                        onPress={() => openNewRun(intent)}
                        style={({ pressed }) => [styles.button, { opacity: pressed ? 0.7 : 1 }]}
                    >
                        <Text style={styles.buttonText}>{t(EXECUTION_RUN_INTENT_LABEL_KEYS[intent])}</Text>
                    </Pressable>
                ))}
                <Pressable
                    testID="session-subagent-launch-execution-run:advanced"
                    accessibilityRole="button"
                    accessibilityLabel={t('session.subagents.panel.launchExecutionRunsAdvanced')}
                    onPress={() => openNewRun()}
                    style={({ pressed }) => [styles.button, { opacity: pressed ? 0.7 : 1, borderColor: theme.colors.border.default }]}
                >
                    <Text style={styles.secondaryText}>{t('session.subagents.panel.launchExecutionRunsAdvanced')}</Text>
                </Pressable>
            </View>
        </SessionSubagentLaunchCardShell>
    );
});
