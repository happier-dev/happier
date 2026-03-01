import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SourceControlOperationsHistorySection } from '@/components/sessions/files/SourceControlOperationsHistorySection';
import { SourceControlOperationsLogSection } from '@/components/sessions/files/SourceControlOperationsLogSection';
import { resolveSourceControlOperationSupport } from '@/components/sessions/files/sourceControlOperationSupport';
import { ScmCommitSelectionSummaryRow } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionSummaryRow';
import { ScmCommitComposerCard } from '@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard';
import { Octicons } from '@expo/vector-icons';
import type { ScmLogEntry } from '@happier-dev/protocol';
import type { ScmProjectInFlightOperation, ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import { t } from '@/text';

type SourceControlOperationsPanelProps = {
    variant?: 'screen' | 'rail';
    hideCommitAction?: boolean;
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
    commitMessageDraft?: string;
    onCommitMessageDraftChange?: (value: string) => void;
    onCommitFromMessage?: (message: string) => void;
};

export function SourceControlOperationsPanel(props: SourceControlOperationsPanelProps) {
    const {
        variant = 'screen',
        hideCommitAction = false,
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
        commitMessageDraft,
        onCommitMessageDraftChange,
        onCommitFromMessage,
    } = props;

    const formatOperationActor = React.useCallback((sessionId: string) => {
        if (sessionId === currentSessionId) {
            return t('files.sourceControlOperations.actorThisSession');
        }
        return t('files.sourceControlOperations.actorSession', { sessionIdPrefix: sessionId.slice(0, 6) });
    }, [currentSessionId]);

    const isLockedByOtherSession = Boolean(
        inFlightScmOperation && inFlightScmOperation.sessionId !== currentSessionId
    );
    const globalLockMessage = isLockedByOtherSession
        ? t('files.sourceControlOperations.globalLock')
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

    const showInlineCommitComposer =
        supportsCommit
        && typeof commitMessageDraft === 'string'
        && typeof onCommitMessageDraftChange === 'function'
        && typeof onCommitFromMessage === 'function';

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
                padding: variant === 'rail' ? 12 : 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surface,
            }}
        >
            {variant === 'screen' ? (
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
                            {t('files.sourceControlOperations.title')}
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
            ) : null}

            {inFlightScmOperation && (
                <Callout tone="neutral">
                    {t('files.sourceControlOperations.running', {
                        operation: inFlightScmOperation.operation,
                        actor: formatOperationActor(inFlightScmOperation.sessionId),
                    })}
                </Callout>
            )}

            {isLockedByOtherSession && (
                <Callout tone="warning">
                    {t('files.sourceControlOperations.lockedBy', {
                        actor: formatOperationActor(inFlightScmOperation!.sessionId),
                    })}
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

            <ScmCommitSelectionSummaryRow
                theme={theme}
                count={commitSelectionCount}
                onClear={onClearCommitSelection}
                density={variant === 'rail' ? 'compact' : 'comfortable'}
            />

            {hasConflicts && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.warning,
                        marginBottom: 10,
                        ...Typography.default('semiBold'),
                    }}
                >
                    {t('files.sourceControlOperations.conflictsDetected')}
                </Text>
            )}

            {showInlineCommitComposer ? (
                <ScmCommitComposerCard
                    theme={theme}
                    commitActionLabel={commitActionLabel}
                    draftMessage={commitMessageDraft!}
                    onDraftMessageChange={onCommitMessageDraftChange!}
                    busy={scmOperationBusy || hasGlobalOperationInFlight}
                    status={null}
                    commitAllowed={commitAllowed && !hasGlobalOperationInFlight && !isLockedByOtherSession}
                    commitBlockedMessage={globalLockMessage ?? commitBlockedMessage}
                    onCommitFromMessage={onCommitFromMessage!}
                    variant={variant === 'rail' ? 'railFooter' : 'card'}
                />
            ) : null}

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: showBlockedHints ? 8 : 12 }}>
                {(supportsCommit && !showInlineCommitComposer && !hideCommitAction) && (
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
                        label={t('files.sourceControlOperations.actions.fetch')}
                        iconName="sync"
                        disabled={scmOperationBusy || hasGlobalOperationInFlight}
                        onPress={onFetch}
                    />
                )}
                {supportsPull && (
                    <ActionChip
                        variant="secondary"
                        label={t('files.sourceControlOperations.actions.pull')}
                        iconName="arrow-down"
                        disabled={scmOperationBusy || hasGlobalOperationInFlight || !pullAllowed}
                        onPress={onPull}
                    />
                )}
                {supportsPush && (
                    <ActionChip
                        variant="secondary"
                        label={t('files.sourceControlOperations.actions.push')}
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
                        <BlockedHint label={t('files.sourceControlOperations.blockedHints.lock')} message={globalLockMessage} />
                    ) : null}
                    {(supportsCommit && !commitAllowed && commitBlockedMessage) && (
                        <BlockedHint label={t('files.sourceControlOperations.blockedHints.commitBlocked')} message={commitBlockedMessage} />
                    )}
                    {(supportsPull && !pullAllowed && pullBlockedMessage) && (
                        <BlockedHint label={t('files.sourceControlOperations.blockedHints.pullBlocked')} message={pullBlockedMessage} />
                    )}
                    {(supportsPush && !pushAllowed && pushBlockedMessage) && (
                        <BlockedHint label={t('files.sourceControlOperations.blockedHints.pushBlocked')} message={pushBlockedMessage} />
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

            {variant === 'screen' ? (
                <SourceControlOperationsLogSection
                    theme={theme}
                    currentSessionId={currentSessionId}
                    operationLog={operationLog}
                    formatOperationActor={formatOperationActor}
                />
            ) : null}
        </View>
    );
}
