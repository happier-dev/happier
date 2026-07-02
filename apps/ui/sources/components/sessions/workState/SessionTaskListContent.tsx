import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TodoChecklist } from '@/components/todos/TodoChecklist';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { groupSessionWorkStateItems } from './sessionWorkStatePresentation';
import type { SessionWorkStateItem, SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

function WorkStateGroup(props: Readonly<{
    title: string;
    items: readonly SessionWorkStateItem[];
    primaryItemId?: string | null;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    if (props.items.length === 0) return null;
    return (
        <View testID={props.testID} style={styles.group}>
            <Text style={[styles.groupTitle, { color: theme.colors.text.secondary }]}>{props.title}</Text>
            <TodoChecklist
                items={props.items.map((item) => ({
                    id: item.id,
                    title: item.title,
                    status: item.status,
                    selected: item.id === props.primaryItemId,
                    testID: `session-work-state-item-${item.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
                }))}
                surface="plain"
                size="compact"
            />
        </View>
    );
}

export function SessionTaskListContent(props: Readonly<{
    snapshot: SessionWorkStateSnapshot | null;
    primaryItemId?: string | null;
}>) {
    const groups = groupSessionWorkStateItems(props.snapshot);
    return (
        <View style={styles.root}>
            <WorkStateGroup title={t('session.workState.group.active')} items={groups.active} primaryItemId={props.primaryItemId} testID="session-work-state-group-active" />
            <WorkStateGroup title={t('session.workState.group.pending')} items={groups.pending} primaryItemId={props.primaryItemId} testID="session-work-state-group-pending" />
            <WorkStateGroup title={t('session.workState.group.blockedPaused')} items={groups.blockedPaused} primaryItemId={props.primaryItemId} testID="session-work-state-group-blocked-paused" />
            <WorkStateGroup title={t('session.workState.group.done')} items={groups.done} primaryItemId={props.primaryItemId} testID="session-work-state-group-done" />
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    root: {
        gap: 12,
    },
    group: {
        gap: 7,
    },
    groupTitle: {
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
    },
}));
