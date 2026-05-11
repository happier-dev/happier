import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import { t } from '@/text';

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
                    color: theme.colors.text.secondary,
                    marginBottom: 6,
                    ...Typography.default('semiBold'),
                }}
            >
                {t('files.sourceControlOperationsLog.title')}
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
                            borderColor: theme.colors.border.default,
                            backgroundColor:
                                operationLogScope === 'all'
                                    ? theme.colors.surface.inset
                                    : theme.colors.surface.base,
                        }}
                    >
                        <Text style={{ fontSize: 11, color: theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                            {t('files.sourceControlOperationsLog.allSessions')}
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={() => setOperationLogScope('session')}
                        style={{
                            paddingHorizontal: 8,
                            paddingVertical: 5,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            backgroundColor:
                                operationLogScope === 'session'
                                    ? theme.colors.surface.inset
                                    : theme.colors.surface.base,
                        }}
                    >
                        <Text style={{ fontSize: 11, color: theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                            {t('files.sourceControlOperationsLog.thisSession')}
                        </Text>
                    </Pressable>
                </View>
            )}
            {visibleOperationLog.length === 0 ? (
                <Text
                    style={{
                        fontSize: 11,
                        color: theme.colors.text.secondary,
                        marginBottom: 4,
                        ...Typography.default(),
                    }}
                >
                    {t('files.sourceControlOperationsLog.emptyThisSession')}
                </Text>
            ) : (
                visibleOperationLog.map((entry) => (
                    <View
                        key={entry.id}
                        style={{
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surface.inset ?? theme.colors.input.background,
                            paddingHorizontal: 10,
                            paddingVertical: 8,
                            marginBottom: 6,
                        }}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                            <Text style={{ flex: 1, fontSize: 11, color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
                                {entry.operation} · {formatOperationActor(entry.sessionId)}
                            </Text>
                            <View
                                style={{
                                    paddingHorizontal: 6,
                                    paddingVertical: 2,
                                    borderRadius: 999,
                                    backgroundColor: entry.status === 'success' ? theme.colors.state.success.foreground : theme.colors.state.neutral.foreground,
                                }}
                            >
                                <Text style={{ fontSize: 10, color: 'white', ...Typography.default('semiBold') }}>
                                    {entry.status.toUpperCase()}
                                </Text>
                            </View>
                        </View>
                        <Text style={{ fontSize: 11, color: theme.colors.text.secondary, marginTop: 2, ...Typography.default() }}>
                            {new Date(entry.timestamp).toLocaleTimeString()}
                            {entry.detail ? ` · ${entry.detail}` : ''}
                        </Text>
                    </View>
                ))
            )}
        </View>
    );
}
