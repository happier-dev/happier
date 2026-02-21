import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';

type SourceControlOperationsLogSectionProps = Readonly<{
    theme: any;
    currentSessionId: string;
    operationLog: ScmProjectOperationLogEntry[];
    formatOperationActor: (sessionId: string) => string;
}>;

export function SourceControlOperationsLogSection(props: SourceControlOperationsLogSectionProps) {
    const { theme, currentSessionId, operationLog, formatOperationActor } = props;
    const [operationLogScope, setOperationLogScope] = React.useState<'all' | 'session'>('all');

    const hasCrossSessionLogEntries = React.useMemo(
        () => operationLog.some((entry) => entry.sessionId !== currentSessionId),
        [currentSessionId, operationLog]
    );

    const visibleOperationLog = React.useMemo(() => {
        const entries = operationLogScope === 'session'
            ? operationLog.filter((entry) => entry.sessionId === currentSessionId)
            : operationLog;
        return [...entries]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 5);
    }, [currentSessionId, operationLog, operationLogScope]);

    if (operationLog.length === 0) {
        return null;
    }

    return (
        <View style={{ marginTop: 10 }}>
            <Text
                style={{
                    fontSize: 12,
                    color: theme.colors.textSecondary,
                    marginBottom: 6,
                    ...Typography.default('semiBold'),
                }}
            >
                Recent source-control operations
            </Text>
            {hasCrossSessionLogEntries && (
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                    <Pressable
                        onPress={() => setOperationLogScope('all')}
                        style={{
                            paddingHorizontal: 8,
                            paddingVertical: 5,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor:
                                operationLogScope === 'all'
                                    ? theme.colors.surfaceHigh
                                    : theme.colors.surface,
                        }}
                    >
                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                            All sessions
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={() => setOperationLogScope('session')}
                        style={{
                            paddingHorizontal: 8,
                            paddingVertical: 5,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor:
                                operationLogScope === 'session'
                                    ? theme.colors.surfaceHigh
                                    : theme.colors.surface,
                        }}
                    >
                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                            This session
                        </Text>
                    </Pressable>
                </View>
            )}
            {visibleOperationLog.length === 0 ? (
                <Text
                    style={{
                        fontSize: 11,
                        color: theme.colors.textSecondary,
                        marginBottom: 4,
                        ...Typography.default(),
                    }}
                >
                    No recent operations for this session.
                </Text>
            ) : (
                visibleOperationLog.map((entry) => (
                    <View
                        key={entry.id}
                        style={{
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                            paddingHorizontal: 10,
                            paddingVertical: 8,
                            marginBottom: 6,
                        }}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                            <Text style={{ flex: 1, fontSize: 11, color: theme.colors.text, ...Typography.default('semiBold') }}>
                                {entry.operation} · {formatOperationActor(entry.sessionId)}
                            </Text>
                            <View
                                style={{
                                    paddingHorizontal: 6,
                                    paddingVertical: 2,
                                    borderRadius: 999,
                                    backgroundColor: entry.status === 'success' ? theme.colors.success : theme.colors.warning,
                                }}
                            >
                                <Text style={{ fontSize: 10, color: 'white', ...Typography.default('semiBold') }}>
                                    {entry.status.toUpperCase()}
                                </Text>
                            </View>
                        </View>
                        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginTop: 2, ...Typography.default() }}>
                            {new Date(entry.timestamp).toLocaleTimeString()}
                            {entry.detail ? ` · ${entry.detail}` : ''}
                        </Text>
                    </View>
                ))
            )}
        </View>
    );
}
