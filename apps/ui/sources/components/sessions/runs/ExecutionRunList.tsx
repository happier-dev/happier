import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ExecutionRunRow, type ExecutionRunRowRun } from './ExecutionRunRow';
import { t } from '@/text';

export const ExecutionRunList = React.memo((props: Readonly<{
    runs: readonly ExecutionRunRowRun[];
    onPressRun?: (run: ExecutionRunRowRun) => void;
}>) => {
    const { theme } = useUnistyles();

    if (!props.runs || props.runs.length === 0) {
        return <Text style={{ color: theme.colors.textSecondary }}>{t('runs.empty') ?? 'No runs yet.'}</Text>;
    }

    const grouped = new Map<string, ExecutionRunRowRun[]>();
    const ungrouped: ExecutionRunRowRun[] = [];
    for (const run of props.runs) {
        const groupId = (run as any)?.display?.groupId;
        if (typeof groupId === 'string' && groupId.trim().length > 0) {
            const key = groupId.trim();
            const bucket = grouped.get(key) ?? [];
            bucket.push(run);
            grouped.set(key, bucket);
            continue;
        }
        ungrouped.push(run);
    }

    const groupEntries = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));

    return (
        <View style={{ gap: 10 }}>
            {groupEntries.map(([groupId, runs]) => (
                <View key={`group:${groupId}`} style={{ gap: 8 }}>
                    <Text style={{ color: theme.colors.textSecondary, fontWeight: '600' }}>
                        {`Group ${groupId}`}
                    </Text>
                    {runs.map((run) => (
                        <ExecutionRunRow
                            key={run.runId}
                            run={run}
                            onPress={props.onPressRun ? () => props.onPressRun?.(run) : undefined}
                        />
                    ))}
                </View>
            ))}

            {ungrouped.map((run) => (
                <ExecutionRunRow
                    key={run.runId}
                    run={run}
                    onPress={props.onPressRun ? () => props.onPressRun?.(run) : undefined}
                />
            ))}
        </View>
    );
});
