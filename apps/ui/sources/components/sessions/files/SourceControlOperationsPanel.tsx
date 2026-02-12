import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { SourceControlOperationsHistorySection } from '@/components/sessions/files/SourceControlOperationsHistorySection';
import { SourceControlOperationsLogSection } from '@/components/sessions/files/SourceControlOperationsLogSection';
import { resolveSourceControlOperationSupport } from '@/components/sessions/files/sourceControlOperationSupport';
import { Octicons } from '@expo/vector-icons';
import type { ScmLogEntry } from '@happier-dev/protocol';
import type { ScmProjectInFlightOperation, ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';

type SourceControlOperationsPanelProps = {
    theme: any;
    backendLabel: string;
    commitActionLabel: string;
    capabilities?: {
        readLog?: boolean;
        writeCommit?: boolean;
        writeRemoteFetch?: boolean;
        writeRemotePull?: boolean;
        writeRemotePush?: boolean;
    } | null;
    currentSessionId: string;
    hasConflicts: boolean;
    scmOperationBusy: boolean;
    hasGlobalOperationInFlight: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    scmOperationStatus: string | null;
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
    historyEntries: ScmLogEntry[];
    historyHasMore: boolean;
    onLoadMoreHistory: () => void;
    onOpenCommit: (sha: string) => void;
    operationLog: ScmProjectOperationLogEntry[];
    commitSelectionCount?: number;
    onClearCommitSelection?: () => void;
};

export function SourceControlOperationsPanel(props: SourceControlOperationsPanelProps) {
    const {
        theme,
        backendLabel,
        commitActionLabel,
        capabilities,
        currentSessionId,
        hasConflicts,
        scmOperationBusy,
        hasGlobalOperationInFlight,
        inFlightScmOperation,
        scmOperationStatus,
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
        commitSelectionCount = 0,
        onClearCommitSelection,
    } = props;

    const formatOperationActor = React.useCallback((sessionId: string) => {
        if (sessionId === currentSessionId) {
            return 'this session';
        }
        return `session ${sessionId.slice(0, 6)}`;
    }, [currentSessionId]);

    const isLockedByOtherSession = Boolean(
        inFlightScmOperation && inFlightScmOperation.sessionId !== currentSessionId
    );
    const globalLockMessage = isLockedByOtherSession
        ? 'Operations are temporarily locked because another session is running a source control command.'
        : null;

    const {
        supportsCommit,
        supportsFetch,
        supportsPull,
        supportsPush,
        supportsHistory,
    } = resolveSourceControlOperationSupport(capabilities);

    const showBlockedHints = Boolean(globalLockMessage)
        || (supportsCommit && !commitAllowed && commitBlockedMessage)
        || (supportsPull && !pullAllowed && pullBlockedMessage)
        || (supportsPush && !pushAllowed && pushBlockedMessage);

    const Callout = (p: { tone: 'neutral' | 'warning'; children: React.ReactNode }) => {
        const borderColor = p.tone === 'warning' ? theme.colors.warning : theme.colors.divider;
        const textColor = p.tone === 'warning' ? theme.colors.warning : theme.colors.textSecondary;
        return (
            <View
                style={{
                    backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    marginBottom: 10,
                }}
            >
                <Text style={{ fontSize: 12, color: textColor, ...Typography.default() }}>
                    {p.children}
                </Text>
            </View>
        );
    };

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

    const BlockedHint = (p: { label: string; message: string }) => (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
            <Octicons name="alert" size={12} color={theme.colors.textSecondary} style={{ marginTop: 2 }} />
            <Text
                style={{
                    flex: 1,
                    fontSize: 11,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {p.label}: {p.message}
            </Text>
        </View>
    );

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
                        Source control
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
                        {backendLabel.toUpperCase()}
                    </Text>
                </View>
            </View>

            {inFlightScmOperation && (
                <Callout tone="neutral">
                    {'Running: '}
                    {inFlightScmOperation.operation}
                    {' \u00b7 '}
                    {formatOperationActor(inFlightScmOperation.sessionId)}
                </Callout>
            )}

            {isLockedByOtherSession && (
                <Callout tone="warning">
                    {'Source control operations are locked by '}
                    {formatOperationActor(inFlightScmOperation!.sessionId)}
                    {'.'}
                </Callout>
            )}

            {scmOperationStatus && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        marginBottom: 10,
                        ...Typography.default(),
                    }}
                >
                    {scmOperationStatus}
                </Text>
            )}

            {commitSelectionCount > 0 && (
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 10,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                    }}
                >
                    <Text
                        style={{
                            flex: 1,
                            fontSize: 12,
                            color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}
                    >
                        {commitSelectionCount === 1
                            ? '1 file selected for the next commit.'
                            : `${commitSelectionCount} files selected for the next commit.`}
                    </Text>
                    {onClearCommitSelection && (
                        <Pressable
                            onPress={onClearCommitSelection}
                            style={({ pressed }) => ({
                                marginLeft: 8,
                                opacity: pressed ? 0.75 : 1,
                            })}
                        >
                            <Text
                                style={{
                                    fontSize: 12,
                                    color: theme.colors.textLink,
                                    ...Typography.default('semiBold'),
                                }}
                            >
                                Clear
                            </Text>
                        </Pressable>
                    )}
                </View>
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
                    Conflicts detected. Commit, pull, and push are blocked until conflicts are resolved.
                </Text>
            )}

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: showBlockedHints ? 8 : 12 }}>
                {supportsCommit && (
                    <ActionChip
                        variant="primary"
                        label={commitActionLabel}
                        iconName="check"
                        disabled={scmOperationBusy || hasGlobalOperationInFlight || !commitAllowed}
                        onPress={onCreateCommit}
                    />
                )}
                {supportsFetch && (
                    <ActionChip
                        variant="secondary"
                        label="Fetch"
                        iconName="sync"
                        disabled={scmOperationBusy || hasGlobalOperationInFlight}
                        onPress={onFetch}
                    />
                )}
                {supportsPull && (
                    <ActionChip
                        variant="secondary"
                        label="Pull"
                        iconName="arrow-down"
                        disabled={scmOperationBusy || hasGlobalOperationInFlight || !pullAllowed}
                        onPress={onPull}
                    />
                )}
                {supportsPush && (
                    <ActionChip
                        variant="secondary"
                        label="Push"
                        iconName="arrow-up"
                        disabled={scmOperationBusy || hasGlobalOperationInFlight || !pushAllowed}
                        onPress={onPush}
                    />
                )}
            </View>

            {showBlockedHints && (
                <View
                    style={{
                        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.input.background,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        marginBottom: 12,
                    }}
                >
                    {globalLockMessage ? (
                        <BlockedHint label="Lock" message={globalLockMessage} />
                    ) : null}
                    {(supportsCommit && !commitAllowed && commitBlockedMessage) && (
                        <BlockedHint label="Commit blocked" message={commitBlockedMessage} />
                    )}
                    {(supportsPull && !pullAllowed && pullBlockedMessage) && (
                        <BlockedHint label="Pull blocked" message={pullBlockedMessage} />
                    )}
                    {(supportsPush && !pushAllowed && pushBlockedMessage) && (
                        <BlockedHint label="Push blocked" message={pushBlockedMessage} />
                    )}
                </View>
            )}

            {supportsHistory && (
                <SourceControlOperationsHistorySection
                    theme={theme}
                    historyLoading={historyLoading}
                    historyEntries={historyEntries}
                    historyHasMore={historyHasMore}
                    onLoadMoreHistory={onLoadMoreHistory}
                    onOpenCommit={onOpenCommit}
                />
            )}

            <SourceControlOperationsLogSection
                theme={theme}
                currentSessionId={currentSessionId}
                operationLog={operationLog}
                formatOperationActor={formatOperationActor}
            />
        </View>
    );
}
