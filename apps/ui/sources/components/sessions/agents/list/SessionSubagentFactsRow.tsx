import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveSessionSubagentFactPills } from '@/components/sessions/agents/presentation/resolveSessionSubagentFactPills';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        flex: 1,
        flexWrap: 'wrap',
    },
    pill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    actionPill: {
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.base,
    },
    pillText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        fontWeight: '600',
    },
}));

export const SessionSubagentFactsRow = React.memo((props: Readonly<{
    subagent: SessionSubagent;
    onOpenAdvanced: (() => void) | null;
}>) => {
    const styles = stylesheet;
    const facts = resolveSessionSubagentFactPills(props.subagent);

    if (facts.length === 0 && !props.onOpenAdvanced) return null;

    return (
        <View testID={`session-subagent-facts:${props.subagent.id}`} style={styles.row}>
            {facts.map((fact) => (
                <View key={fact} style={styles.pill}>
                    <Text style={styles.pillText}>{fact}</Text>
                </View>
            ))}
            {props.onOpenAdvanced ? (
                <Pressable
                    testID={`session-subagent-open-advanced:${props.subagent.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.subagents.panel.openAdvancedRun')}
                    onPress={props.onOpenAdvanced}
                    style={({ pressed }) => [styles.pill, styles.actionPill, { opacity: pressed ? 0.7 : 1 }]}
                >
                    <Text style={styles.pillText}>{t('session.subagents.panel.openAdvancedRun')}</Text>
                </Pressable>
            ) : null}
        </View>
    );
});
