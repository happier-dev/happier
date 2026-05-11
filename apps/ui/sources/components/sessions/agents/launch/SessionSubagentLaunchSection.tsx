import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionSubagentLaunchCards } from '@/agents/registry/sessionSubagentUiBehavior';
import { ExecutionRunLaunchCard } from '@/components/sessions/agents/launch/ExecutionRunLaunchCard';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        gap: 10,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerCopy: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    title: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        fontWeight: '700',
        textTransform: 'uppercase',
    },
    subtitle: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    toggleButton: {
        minHeight: 32,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    toggleText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        fontWeight: '600',
    },
    cards: {
        gap: 12,
    },
}));

export const SessionSubagentLaunchSection = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
    session: Session | null;
    subagents: readonly SessionSubagent[];
}>) => {
    const styles = stylesheet;
    const { canShowExecutionRunLauncher } = useSessionExecutionRunLaunchability(props.sessionId, props.session);
    const [expanded, setExpanded] = React.useState(() => props.subagents.length === 0);
    const providerLaunchCards = React.useMemo(() => getSessionSubagentLaunchCards({
        sessionId: props.sessionId,
        scopeId: props.scopeId,
        session: props.session,
        subagents: props.subagents,
    }), [props.scopeId, props.session, props.sessionId, props.subagents]);

    if (!canShowExecutionRunLauncher && providerLaunchCards.length === 0) {
        return null;
    }

    return (
        <View testID="session-subagents-launch-section" style={styles.container}>
            <View style={styles.header}>
                <View testID="session-subagents-launch-section-title" style={styles.headerCopy}>
                    <Text style={styles.title}>{t('session.subagents.panel.launchSectionTitle')}</Text>
                    {expanded ? (
                        <Text style={styles.subtitle}>{t('session.subagents.panel.launchSectionSubtitle')}</Text>
                    ) : null}
                </View>
                <Pressable
                    testID="session-subagents-launch-section-toggle"
                    accessibilityRole="button"
                    accessibilityLabel={expanded ? t('common.collapse') : t('common.expand')}
                    onPress={() => {
                        setExpanded((previous) => !previous);
                    }}
                    style={({ pressed }) => [styles.toggleButton, { opacity: pressed ? 0.75 : 1 }]}
                >
                    <Ionicons name={expanded ? 'chevron-up-outline' : 'chevron-down-outline'} size={14} color={styles.toggleText.color} />
                    <Text style={styles.toggleText}>{expanded ? t('common.collapse') : t('common.expand')}</Text>
                </Pressable>
            </View>
            {expanded ? (
                <View style={styles.cards}>
                    {canShowExecutionRunLauncher ? <ExecutionRunLaunchCard sessionId={props.sessionId} scopeId={props.scopeId} /> : null}
                    {providerLaunchCards}
                </View>
            ) : null}
        </View>
    );
});
