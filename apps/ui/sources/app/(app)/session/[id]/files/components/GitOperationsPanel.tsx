import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { Octicons } from '@expo/vector-icons';
import type { GitLogEntry } from '@happier-dev/protocol';
import type { GitProjectInFlightOperation, GitProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';

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

    const showBlockedHints = (!commitAllowed && commitBlockedMessage)
        || (!pullAllowed && pullBlockedMessage)
        || (!pushAllowed && pushBlockedMessage);

    const actionChipStyle = React.useCallback((opts: {
        pressed: boolean;
        disabled: boolean;
        variant: 'primary' | 'secondary';
    }) => {
        const { pressed, disabled, variant } = opts;
        const bgBase = variant === 'primary'
            ? theme.colors.success
            : (theme.colors.surfaceHigh ?? theme.colors.input.background);
        const bg = pressed && !disabled ? (theme.colors.surfaceHigh ?? bgBase) : bgBase;
        const border = variant === 'primary' ? theme.colors.success : theme.colors.divider;
        return {
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: border,
            backgroundColor: bg,
            opacity: disabled ? 0.55 : pressed ? 0.85 : 1,
        } as const;
    }, [theme.colors]);

    const ActionChip = (p: {
        variant: 'primary' | 'secondary';
        label: string;
        iconName: string;
        disabled: boolean;
        onPress: () => void;
    }) => {
        const labelColor = p.variant === 'primary' ? 'white' : theme.colors.text;
        const iconColor = p.variant === 'primary' ? 'white' : theme.colors.textSecondary;
        return (
            <Pressable
                disabled={p.disabled}
                onPress={p.onPress}
                style={(s) => actionChipStyle({
                    pressed: s.pressed,
                    disabled: p.disabled,
                    variant: p.variant,
                })}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Octicons name={p.iconName as any} size={14} color={iconColor} />
                    <Text style={{ color: labelColor, fontSize: 12, ...Typography.default('semiBold') }}>
                        {p.label}
                    </Text>
                </View>
            </Pressable>
        );
    };

    return (
        <View
            style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surface,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Octicons name="git-commit" size={16} color={theme.colors.textSecondary} />
                    <Text
                        style={{
                            fontSize: 14,
                            color: theme.colors.text,
                            letterSpacing: 0.3,
                            ...Typography.default('semiBold'),
                        }}
                    >
                        Git operations
                    </Text>
                </View>
                <View
                    style={{
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                    }}
                >
                    <Text
                        style={{
                            fontSize: 10,
                            letterSpacing: 0.3,
                            color: theme.colors.textSecondary,
                            ...Typography.default('semiBold'),
                        }}
                    >
                        EXPERIMENTAL
                    </Text>
                </View>
            </View>

            {inFlightGitOperation && (
                <View
                    style={{
                        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        marginBottom: 10,
                    }}
                >
                    <Text
                        style={{
                            fontSize: 12,
                            color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}
                    >
                        Running: {inFlightGitOperation.operation} {' · '}
                        {formatOperationActor(inFlightGitOperation.sessionId)}
                    </Text>
                </View>
            )}

            {isLockedByOtherSession && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.warning,
                        marginBottom: 10,
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
                        marginBottom: 10,
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
                        marginBottom: 10,
                        ...Typography.default('semiBold'),
                    }}
                >
                    Conflicts detected. Write operations are disabled until resolved.
                </Text>
            )}

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: showBlockedHints ? 8 : 12 }}>
                <ActionChip
                    variant="primary"
                    label="Commit staged"
                    iconName="check"
                    disabled={gitOperationBusy || hasGlobalOperationInFlight || !commitAllowed}
                    onPress={onCreateCommit}
                />
                <ActionChip
                    variant="secondary"
                    label="Fetch"
                    iconName="sync"
                    disabled={gitOperationBusy || hasGlobalOperationInFlight}
                    onPress={onFetch}
                />
                <ActionChip
                    variant="secondary"
                    label="Pull"
                    iconName="arrow-down"
                    disabled={gitOperationBusy || hasGlobalOperationInFlight || !pullAllowed}
                    onPress={onPull}
                />
                <ActionChip
                    variant="secondary"
                    label="Push"
                    iconName="arrow-up"
                    disabled={gitOperationBusy || hasGlobalOperationInFlight || !pushAllowed}
                    onPress={onPush}
                />
            </View>

            {showBlockedHints && (
                <View
                    style={{
                        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        marginBottom: 12,
                    }}
                >
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
                                ...Typography.default(),
                            }}
                        >
                            Push blocked: {pushBlockedMessage}
                        </Text>
                    )}
                </View>
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
                        <Pressable
                            key={entry.sha}
                            onPress={() => onOpenCommit(entry.sha)}
                            style={(p) => ({
                                paddingVertical: 10,
                                paddingHorizontal: 10,
                                borderRadius: 12,
                                backgroundColor: p.pressed
                                    ? (theme.colors.surfaceHigh ?? theme.colors.input.background)
                                    : 'transparent',
                            })}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                <View
                                    style={{
                                        paddingHorizontal: 8,
                                        paddingVertical: 6,
                                        borderRadius: 10,
                                        borderWidth: 1,
                                        borderColor: theme.colors.divider,
                                        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                                    }}
                                >
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 11, ...Typography.mono('semiBold') }}>
                                        {entry.shortSha}
                                    </Text>
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text
                                        style={{ color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }}
                                        numberOfLines={1}
                                    >
                                        {entry.subject}
                                    </Text>
                                    <Text style={{ color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() }}>
                                        {new Date(entry.timestamp).toLocaleString()}
                                    </Text>
                                </View>
                                <Octicons name="chevron-right" size={14} color={theme.colors.textSecondary} />
                            </View>
                        </Pressable>
                    ))}
                    {historyHasMore && (
                        <Pressable
                            disabled={historyLoading}
                            onPress={onLoadMoreHistory}
                            style={(p) => ({
                                marginTop: 4,
                                paddingVertical: 10,
                                paddingHorizontal: 10,
                                borderRadius: 12,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                                backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                                opacity: historyLoading ? 0.6 : p.pressed ? 0.85 : 1,
                            })}
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                <Text style={{ color: theme.colors.textLink, fontSize: 12, ...Typography.default('semiBold') }}>
                                    {historyLoading ? 'Loading…' : 'Load more commits'}
                                </Text>
                                <Octicons name="chevron-down" size={14} color={theme.colors.textSecondary} />
                            </View>
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
