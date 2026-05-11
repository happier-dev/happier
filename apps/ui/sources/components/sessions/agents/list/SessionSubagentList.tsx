import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { t } from '@/text';

import { groupSessionSubagents } from './groupSessionSubagents';
import { SessionSubagentGroup } from './SessionSubagentGroup';

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        gap: 12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    title: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        fontWeight: '700',
        textTransform: 'uppercase',
    },
    countPill: {
        minWidth: 22,
        height: 22,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        alignItems: 'center',
        justifyContent: 'center',
    },
    countText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '700',
    },
    empty: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
}));

export const SessionSubagentList = React.memo((props: Readonly<{
    sessionId: string;
    testID: string;
    title: string;
    emptyLabel: string;
    subagents: readonly SessionSubagent[];
    activityPreviewById: ReadonlyMap<string, string>;
    pendingPermissionById: ReadonlyMap<string, boolean>;
    onOpenPreview: (subagent: SessionSubagent) => void;
    onOpenFull: (subagent: SessionSubagent) => void;
    onOpenAdvanced: (subagent: SessionSubagent) => void;
    onLaunchTeammate?: ((teamId: string) => void) | null;
}>) => {
    const styles = stylesheet;
    const groups = React.useMemo(() => groupSessionSubagents(props.subagents), [props.subagents]);

    return (
        <View testID={props.testID} style={styles.section}>
            <View style={styles.header}>
                <Text style={styles.title}>{props.title}</Text>
                <View testID={`session-agents-section-count:${props.testID}`} style={styles.countPill}>
                    <Text style={styles.countText}>{t('session.subagents.panel.sectionCount', { count: props.subagents.length })}</Text>
                </View>
            </View>
            {groups.length === 0 ? (
                <Text style={styles.empty}>{props.emptyLabel}</Text>
            ) : groups.map((group) => (
                <SessionSubagentGroup
                    key={group.key}
                    sessionId={props.sessionId}
                    label={group.label}
                    subagents={group.items}
                    activityPreviewById={props.activityPreviewById}
                    pendingPermissionById={props.pendingPermissionById}
                    onOpenPreview={props.onOpenPreview}
                    onOpenFull={props.onOpenFull}
                    onOpenAdvanced={props.onOpenAdvanced}
                    onLaunchTeammate={props.onLaunchTeammate}
                />
            ))}
        </View>
    );
});
