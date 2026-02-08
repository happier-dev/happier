import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import type { GitLogEntry } from '@happier-dev/protocol';
import type { GitProjectInFlightOperation, GitProjectOperationLogEntry } from '@/sync/projectManager';

type GitOperationsPanelProps = {
    theme: any;
    currentSessionId: string;
    hasConflicts: boolean;
    gitOperationBusy: boolean;
    hasGlobalOperationInFlight: boolean;
    inFlightGitOperation: GitProjectInFlightOperation | null;
    gitOperationStatus: string | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;
    pullAllowed: boolean;
    pullBlockedMessage: string | null;
    pushAllowed: boolean;
    pushBlockedMessage: string | null;
    onCreateCommit: () => void;
    onFetch: () => void;
    onPull: () => void;
    onPush: () => void;
    historyLoading: boolean;
    historyEntries: GitLogEntry[];
    historyHasMore: boolean;
    onLoadMoreHistory: () => void;
    onOpenCommit: (sha: string) => void;
    operationLog: GitProjectOperationLogEntry[];
};

export function GitOperationsPanel(props: GitOperationsPanelProps) {
    const {
        theme,
        currentSessionId,
        hasConflicts,
        gitOperationBusy,
        hasGlobalOperationInFlight,
        inFlightGitOperation,
        gitOperationStatus,
        commitAllowed,
        commitBlockedMessage,
        pullAllowed,
        pullBlockedMessage,
        pushAllowed,
        pushBlockedMessage,
        onCreateCommit,
        onFetch,
        onPull,
        onPush,
        historyLoading,
        historyEntries,
        historyHasMore,
        onLoadMoreHistory,
        onOpenCommit,
        operationLog,
    } = props;

    const [operationLogScope, setOperationLogScope] = React.useState<'all' | 'session'>('all');

    const formatOperationActor = React.useCallback((sessionId: string) => {
        if (sessionId === currentSessionId) {
            return 'this session';
        }
        return `session ${sessionId.slice(0, 6)}`;
    }, [currentSessionId]);

    const isLockedByOtherSession = Boolean(
        inFlightGitOperation && inFlightGitOperation.sessionId !== currentSessionId
    );
    const hasCrossSessionLogEntries = React.useMemo(
        () => operationLog.some((entry) => entry.sessionId !== currentSessionId),
        [currentSessionId, operationLog]
    );
    const visibleOperationLog = React.useMemo(() => {
        const entries = operationLogScope === 'session'
            ? operationLog.filter((entry) => entry.sessionId === currentSessionId)
            : operationLog;
        return entries.slice(0, 5);
    }, [currentSessionId, operationLog, operationLogScope]);

    return (
        <View
            style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
            }}
        >
            <Text
                style={{
                    fontSize: 13,
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...Typography.default('semiBold'),
                }}
            >
                Git operations (experimental)
            </Text>

            {inFlightGitOperation && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default(),
                    }}
                >
                    Running: {inFlightGitOperation.operation} {' · '}
                    {formatOperationActor(inFlightGitOperation.sessionId)}
                </Text>
            )}

            {isLockedByOtherSession && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.warning,
                        marginBottom: 8,
                        ...Typography.default('semiBold'),
                    }}
                >
                    Git operations are locked by {formatOperationActor(inFlightGitOperation!.sessionId)}.
                </Text>
            )}

            {gitOperationStatus && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default(),
                    }}
                >
                    {gitOperationStatus}
                </Text>
            )}

            {hasConflicts && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.warning,
                        marginBottom: 8,
                        ...Typography.default('semiBold'),
                    }}
                >
                    Conflicts detected. Write operations are disabled until resolved.
                </Text>
            )}

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                <Pressable
                    disabled={gitOperationBusy || hasGlobalOperationInFlight || !commitAllowed}
                    onPress={onCreateCommit}
                    style={{
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                        borderRadius: 8,
                        backgroundColor: theme.colors.success,
                        opacity: gitOperationBusy || hasGlobalOperationInFlight || !commitAllowed ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: 'white', fontSize: 12, ...Typography.default('semiBold') }}>
                        Commit staged
                    </Text>
                </Pressable>
                <Pressable
                    disabled={gitOperationBusy || hasGlobalOperationInFlight}
                    onPress={onFetch}
                    style={{
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                        borderRadius: 8,
                        backgroundColor: theme.colors.input.background,
                        opacity: gitOperationBusy || hasGlobalOperationInFlight ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.default('semiBold') }}>
                        Fetch
                    </Text>
                </Pressable>
                <Pressable
                    disabled={gitOperationBusy || hasGlobalOperationInFlight || !pullAllowed}
                    onPress={onPull}
                    style={{
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                        borderRadius: 8,
                        backgroundColor: theme.colors.input.background,
                        opacity: gitOperationBusy || hasGlobalOperationInFlight || !pullAllowed ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.default('semiBold') }}>
                        Pull
                    </Text>
                </Pressable>
                <Pressable
                    disabled={gitOperationBusy || hasGlobalOperationInFlight || !pushAllowed}
                    onPress={onPush}
                    style={{
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                        borderRadius: 8,
                        backgroundColor: theme.colors.input.background,
                        opacity: gitOperationBusy || hasGlobalOperationInFlight || !pushAllowed ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.default('semiBold') }}>
                        Push
                    </Text>
                </Pressable>
            </View>

            {(!commitAllowed && commitBlockedMessage) && (
                <Text
                    style={{
                        fontSize: 11,
                        color: theme.colors.textSecondary,
                        marginBottom: 4,
                        ...Typography.default(),
                    }}
                >
                    Commit blocked: {commitBlockedMessage}
                </Text>
            )}
            {(!pullAllowed && pullBlockedMessage) && (
                <Text
                    style={{
                        fontSize: 11,
                        color: theme.colors.textSecondary,
                        marginBottom: 4,
                        ...Typography.default(),
                    }}
                >
                    Pull blocked: {pullBlockedMessage}
                </Text>
            )}
            {(!pushAllowed && pushBlockedMessage) && (
                <Text
                    style={{
                        fontSize: 11,
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default(),
                    }}
                >
                    Push blocked: {pushBlockedMessage}
                </Text>
            )}

            {historyLoading && historyEntries.length === 0 ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : historyEntries.length > 0 ? (
                <View>
                    <Text
                        style={{
                            fontSize: 12,
                            color: theme.colors.textSecondary,
                            marginBottom: 6,
                            ...Typography.default('semiBold'),
                        }}
                    >
                        Recent commits
                    </Text>
                    {historyEntries.slice(0, 5).map((entry) => (
                        <Pressable key={entry.sha} onPress={() => onOpenCommit(entry.sha)} style={{ paddingVertical: 6 }}>
                            <Text style={{ color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }}>
                                {entry.shortSha} {entry.subject}
                            </Text>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() }}>
                                {new Date(entry.timestamp).toLocaleString()}
                            </Text>
                        </Pressable>
                    ))}
                    {historyHasMore && (
                        <Pressable disabled={historyLoading} onPress={onLoadMoreHistory} style={{ paddingVertical: 8 }}>
                            <Text style={{ color: theme.colors.textLink, fontSize: 12, ...Typography.default('semiBold') }}>
                                {historyLoading ? 'Loading…' : 'Load more commits'}
                            </Text>
                        </Pressable>
                    )}
                </View>
            ) : (
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                    No commits available.
                </Text>
            )}

            {operationLog.length > 0 && (
                <View style={{ marginTop: 10 }}>
                    <Text
                        style={{
                            fontSize: 12,
                            color: theme.colors.textSecondary,
                            marginBottom: 6,
                            ...Typography.default('semiBold'),
                        }}
                    >
                        Recent Git operations
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
                            <Text
                                key={entry.id}
                                style={{
                                    fontSize: 11,
                                    color: entry.status === 'success' ? theme.colors.textSecondary : theme.colors.textDestructive,
                                    marginBottom: 4,
                                    ...Typography.default(),
                                }}
                            >
                                {new Date(entry.timestamp).toLocaleTimeString()} · {entry.operation} · {entry.status}
                                {' · '}
                                {formatOperationActor(entry.sessionId)}
                                {entry.detail ? ` · ${entry.detail}` : ''}
                            </Text>
                        ))
                    )}
                </View>
            )}
        </View>
    );
}
