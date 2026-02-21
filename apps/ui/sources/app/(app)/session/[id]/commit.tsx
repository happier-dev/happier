import * as React from 'react';
import { View, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/ui/text/Text';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { Typography } from '@/constants/Typography';
import { sessionScmCommitBackout, sessionScmDiffCommit } from '@/sync/ops';
import {
    storage,
    useSession,
    useSessions,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmSnapshot,
} from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { canRevertFromSnapshot } from '@/scm/operations/safety';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { buildRevertConfirmBody } from '@/scm/operations/revertFeedback';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation, trackBlockedScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

function decodeSha(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export default function CommitScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { id: sessionIdParam } = useLocalSearchParams<{ id: string }>();
    const sessionId = sessionIdParam || '';
    const { sha: shaParam } = useLocalSearchParams<{ sha: string }>();
    // Commit refs cannot contain whitespace; accept accidental "oneline" strings by taking the first token.
    const shaRaw = decodeSha(shaParam || '').trim();
    const sha = shaRaw.split(/\s+/)[0] ?? '';

    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const scmSnapshot = useSessionProjectScmSnapshot(sessionId);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(sessionId);
    const canRevert = canRevertFromSnapshot(scmSnapshot);

    const [isLoading, setIsLoading] = React.useState(true);
    const [isReverting, setIsReverting] = React.useState(false);
    const [diff, setDiff] = React.useState<string>('');
    const [error, setError] = React.useState<string | null>(null);
    const codeLines = React.useMemo(() => buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff }), [diff]);

    // Avoid reading sessionPath via storage.getState() because deep-links can render
    // before session metadata is hydrated. We need a subscription so the screen can
    // recover once storage becomes ready.
    const sessionsData = useSessions();
    const isStorageReady = sessionsData !== null;
    const session = useSession(sessionId);
    const sessionPath = session?.metadata?.path ?? null;

    const loadCommit = React.useCallback(async () => {
        if (!sessionId || !sha) {
            setError('Missing commit context');
            setIsLoading(false);
            return;
        }

        // Deep-links can happen before storage is ready. Keep the loading state until we have
        // enough context to run the diff request, or until we can conclusively say the session
        // is missing.
        if (!isStorageReady) {
            setIsLoading(true);
            setError(null);
            return;
        }

        if (!session || !sessionPath) {
            setError('Missing commit context');
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setError(null);
        try {
            const response = await sessionScmDiffCommit(sessionId, {
                commit: sha,
            });

            if (!response.success) {
                setError(response.error || 'Failed to load commit diff');
                setDiff('');
                return;
            }

            setDiff(response.diff ?? '');
        } catch (err) {
            setError((err as any)?.message || 'Failed to load commit diff');
            setDiff('');
        } finally {
            setIsLoading(false);
        }
    }, [isStorageReady, session, sessionId, sessionPath, sha]);

    React.useEffect(() => {
        loadCommit();
    }, [loadCommit]);

    const revertCommit = React.useCallback(async () => {
        const preflight = evaluateScmOperationPreflight({
            intent: 'revert',
            scmWriteEnabled,
            sessionPath,
            snapshot: scmSnapshot,
        });
        if (!preflight.allowed) {
            trackBlockedScmOperation({
                operation: 'revert',
                reason: 'preflight',
                message: preflight.message,
                surface: 'commit',
                tracking,
            });
            Modal.alert('Error', preflight.message);
            return;
        }
        const cwd = sessionPath;
        if (!cwd) return;

        const confirmed = await Modal.confirm(
            'Revert commit',
            buildRevertConfirmBody({
                commit: sha,
                branch: scmSnapshot?.branch.head ?? null,
                detached: scmSnapshot?.branch.detached ?? false,
                detachedLabel: t('files.detachedHead'),
            }),
            { confirmText: 'Revert', cancelText: 'Cancel' }
        );
        if (!confirmed) return;
        const lockResult = await withSessionProjectScmOperationLock({
            state: storage.getState(),
            sessionId,
            operation: 'revert',
            run: async () => {
                setIsReverting(true);
                try {
                    const response = await sessionScmCommitBackout(sessionId, {
                        commit: sha,
                    });

                    if (!response.success) {
                        const errorMessage = getScmUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || 'Failed to revert commit',
                        });
                        reportSessionScmOperation({
                            state: storage.getState(),
                            sessionId,
                            operation: 'revert',
                            status: 'failed',
                            detail: errorMessage,
                            errorCode: response.errorCode,
                            surface: 'commit',
                            tracking,
                        });
                        Modal.alert('Error', errorMessage);
                        return;
                    }

                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId,
                        operation: 'revert',
                        status: 'success',
                        detail: sha,
                        surface: 'commit',
                        tracking,
                    });
                    await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                    Modal.alert('Success', 'Commit reverted successfully');
                } catch (err) {
                    const errorMessage = (err as any)?.message || 'Failed to revert commit';
                    reportSessionScmOperation({
                        state: storage.getState(),
                        sessionId,
                        operation: 'revert',
                        status: 'failed',
                        detail: errorMessage,
                        surface: 'commit',
                        tracking,
                    });
                    Modal.alert(t('common.error'), errorMessage);
                } finally {
                    setIsReverting(false);
                }
            },
        });
        if (!lockResult.started) {
            trackBlockedScmOperation({
                operation: 'revert',
                reason: 'lock',
                message: lockResult.message,
                surface: 'commit',
                tracking,
            });
            Modal.alert('Error', lockResult.message);
        }
    }, [scmSnapshot, scmWriteEnabled, sessionId, sessionPath, sha]);

    if (isLoading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (error) {
        return (
            <View style={styles.centered}>
                <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingHorizontal: 16 }}>
                    <Text style={{ color: theme.colors.text, fontSize: 16, ...Typography.default('semiBold') }}>
                        Commit diff unavailable
                    </Text>
                    <Text style={{ marginTop: 6, color: theme.colors.textDestructive, ...Typography.default('semiBold') }}>
                        {error}
                    </Text>
                    <Text style={{ marginTop: 10, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                        Try opening the commit again from the Files screen.
                    </Text>
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            marginTop: 14,
                            alignSelf: 'flex-start',
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
                        }}
                    >
                        <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.default('semiBold') }}>
                            Back
                        </Text>
                    </Pressable>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}> 
            <View
                style={{
                    padding: 16,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                }}
            >
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...Typography.default('semiBold') }}>
                    Commit
                </Text>
                <Text style={{ color: theme.colors.text, fontSize: 14, ...Typography.mono() }}>{sha}</Text>
                {inFlightScmOperation && (
                    <Text style={{ marginTop: 6, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                        Running: {inFlightScmOperation.operation}
                    </Text>
                )}

                {scmWriteEnabled && (
                    <>
                        <Pressable
                            disabled={isReverting || !canRevert || Boolean(inFlightScmOperation)}
                            onPress={revertCommit}
                            style={{
                                marginTop: 10,
                                alignSelf: 'flex-start',
                                paddingHorizontal: 12,
                                paddingVertical: 7,
                                borderRadius: 8,
                                backgroundColor: theme.colors.warning,
                                opacity: isReverting || !canRevert || Boolean(inFlightScmOperation) ? 0.6 : 1,
                            }}
                        >
                            <Text style={{ color: 'white', fontSize: 12, ...Typography.default('semiBold') }}>Revert commit</Text>
                        </Pressable>
                        {!canRevert && (
                            <Text style={{ marginTop: 6, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                                Revert is available only when there are no local changes or conflicts.
                            </Text>
                        )}
                    </>
                )}
            </View>

            <View style={{ flex: 1, padding: 16 }}>
                <CodeLinesView lines={codeLines} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
}));
