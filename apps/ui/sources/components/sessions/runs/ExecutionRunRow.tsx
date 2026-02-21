import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { ExecutionRunStatusPill } from './ExecutionRunStatusPill';
import { Text } from '@/components/ui/text/Text';


export type ExecutionRunRowRun =
    Pick<ExecutionRunPublicState, 'runId' | 'intent' | 'backendId' | 'status' | 'display'>
    & Partial<Pick<ExecutionRunPublicState, 'startedAtMs' | 'finishedAtMs'>>;

export const ExecutionRunRow = React.memo((props: Readonly<{
    run: ExecutionRunRowRun;
    onPress?: () => void;
    subtitle?: string;
    rightAccessory?: React.ReactNode;
}>) => {
    const { theme } = useUnistyles();
    const { run, onPress } = props;
    const subtitle = typeof props.subtitle === 'string' ? props.subtitle : run.runId;
    const title =
        (run.display && typeof run.display === 'object' && typeof (run.display as any).title === 'string' && String((run.display as any).title).trim().length > 0)
            ? String((run.display as any).title).trim()
            : (run.display && typeof run.display === 'object' && typeof (run.display as any).participantLabel === 'string' && String((run.display as any).participantLabel).trim().length > 0)
                ? String((run.display as any).participantLabel).trim()
                : `${run.intent} · ${run.backendId}`;

    return (
        <Pressable
            onPress={onPress}
            disabled={!onPress}
            style={({ pressed }) => ({
                padding: 12,
                borderRadius: 12,
                backgroundColor: theme.colors.surfaceHigh,
                borderWidth: 1,
                borderColor: theme.colors.divider,
                gap: 8,
                opacity: pressed ? 0.8 : 1,
            })}
        >
            <View style={styles.row}>
                <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
                    {title}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ExecutionRunStatusPill status={run.status} />
                    {props.rightAccessory ?? null}
                </View>
            </View>
            <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                {subtitle}
            </Text>
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    title: {
        fontWeight: '600',
        fontSize: 13,
    },
    subtitle: {
        fontFamily: 'Menlo',
        fontSize: 12,
    },
}));
