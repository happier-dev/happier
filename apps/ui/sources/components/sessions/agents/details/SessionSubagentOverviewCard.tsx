import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveSessionSubagentFactPills } from '@/components/sessions/agents/presentation/resolveSessionSubagentFactPills';
import { Text } from '@/components/ui/text/Text';
import { resolveSessionSubagentPrimaryTitle } from '@/components/sessions/agents/presentation/resolveSessionSubagentPrimaryTitle';
import { resolveSessionSubagentSecondaryTitle } from '@/components/sessions/agents/presentation/resolveSessionSubagentSecondaryTitle';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        gap: 12,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerCopy: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    title: {
        color: theme.colors.text.primary,
        fontSize: 15,
        fontWeight: '700',
    },
    subtitle: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    statusPill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    statusText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        fontWeight: '700',
    },
    facts: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    factPill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    factText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        fontWeight: '600',
    },
}));

function resolveSubtitle(subagent: SessionSubagent): string | null {
    const values = [
        resolveSessionSubagentSecondaryTitle(subagent),
        subagent.display.subtitle?.trim() || null,
        subagent.recipient?.kind === 'agent_team_member' ? subagent.recipient.teamId.trim() : null,
    ].filter((value, index, all): value is string => typeof value === 'string' && value.length > 0 && all.indexOf(value) === index);

    return values.length > 0 ? values.join(' · ') : null;
}

export const SessionSubagentOverviewCard = React.memo((props: Readonly<{
    subagent: SessionSubagent;
}>) => {
    const styles = stylesheet;
    const subtitle = resolveSubtitle(props.subagent);
    const facts = resolveSessionSubagentFactPills(props.subagent);

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                <View style={styles.headerCopy}>
                    <Text style={styles.title}>{resolveSessionSubagentPrimaryTitle(props.subagent)}</Text>
                    {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
                </View>
                <View style={styles.statusPill}>
                    <Text style={styles.statusText}>{props.subagent.status}</Text>
                </View>
            </View>
            {facts.length > 0 ? (
                <View style={styles.facts}>
                    {facts.map((fact) => (
                        <View key={fact} style={styles.factPill}>
                            <Text style={styles.factText}>{fact}</Text>
                        </View>
                    ))}
                </View>
            ) : null}
        </View>
    );
});
