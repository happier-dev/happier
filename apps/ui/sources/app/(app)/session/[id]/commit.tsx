import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/ui/text/StyledText';
import { GitDiffDisplay } from '@/components/git/diff/GitDiffDisplay';
import { Typography } from '@/constants/Typography';
import { sessionGitCommitRevert, sessionGitDiffCommit } from '@/sync/ops';
import {
    storage,
    useSession,
    useSessions,
    useSessionProjectGitInFlightOperation,
    useSessionProjectGitSnapshot,
    useSetting,
} from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { gitStatusSync } from '@/sync/git/gitStatusSync';
import { canRevertFromSnapshot } from '@/sync/git/operations/safety';
import { evaluateGitOperationPreflight } from '@/sync/git/operations/policy';
import { getGitUserFacingError } from '@/sync/git/operations/userFacingErrors';
import { resolveGitWriteEnabled } from '@/sync/git/operations/featureFlags';
import { buildRevertConfirmBody } from '@/sync/git/operations/revertFeedback';
import { withSessionProjectGitOperationLock } from '@/sync/git/operations/withOperationLock';
import { reportSessionGitOperation, trackBlockedGitOperation } from '@/sync/git/operations/reporting';
import { tracking } from '@/track';

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

    const experiments = useSetting('experiments');
    const expGitOperations = useSetting('expGitOperations');
    const gitWriteEnabled = resolveGitWriteEnabled({
        experiments,
        expGitOperations,
    });
    const gitSnapshot = useSessionProjectGitSnapshot(sessionId);
    const inFlightGitOperation = useSessionProjectGitInFlightOperation(sessionId);
    const canRevert = canRevertFromSnapshot(gitSnapshot);

    const [isLoading, setIsLoading] = React.useState(true);
    const [isReverting, setIsReverting] = React.useState(false);
    const [diff, setDiff] = React.useState<string>('');
    const [error, setError] = React.useState<string | null>(null);

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
            const response = await sessionGitDiffCommit(sessionId, {
                cwd: sessionPath,
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
        const preflight = evaluateGitOperationPreflight({
            intent: 'revert',
            gitWriteEnabled,
            sessionPath,
            snapshot: gitSnapshot,
        });
        if (!preflight.allowed) {
            trackBlockedGitOperation({
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
                branch: gitSnapshot?.branch.head ?? null,
                detached: gitSnapshot?.branch.detached ?? false,
                detachedLabel: t('files.detachedHead'),
            }),
            { confirmText: 'Revert', cancelText: 'Cancel' }
        );
        if (!confirmed) return;
        const lockResult = await withSessionProjectGitOperationLock({
            state: storage.getState(),
            sessionId,
            operation: 'revert',
            run: async () => {
                setIsReverting(true);
                try {
                    const response = await sessionGitCommitRevert(sessionId, {
                        cwd,
                        commit: sha,
                    });

                    if (!response.success) {
                        const errorMessage = getGitUserFacingError({
                            errorCode: response.errorCode,
                            error: response.error,
                            fallback: response.error || 'Failed to revert commit',
                        });
                        reportSessionGitOperation({
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

                    reportSessionGitOperation({
                        state: storage.getState(),
                        sessionId,
                        operation: 'revert',
                        status: 'success',
                        detail: sha,
                        surface: 'commit',
                        tracking,
                    });
                    await gitStatusSync.invalidateFromMutationAndAwait(sessionId);
                    Modal.alert('Success', 'Commit reverted successfully');
                } catch (err) {
                    const errorMessage = (err as any)?.message || 'Failed to revert commit';
                    reportSessionGitOperation({
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
            trackBlockedGitOperation({
                operation: 'revert',
                reason: 'lock',
                message: lockResult.message,
                surface: 'commit',
                tracking,
            });
            Modal.alert('Error', lockResult.message);
        }
    }, [gitSnapshot, gitWriteEnabled, sessionId, sessionPath, sha]);

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
                {inFlightGitOperation && (
                    <Text style={{ marginTop: 6, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                        Running: {inFlightGitOperation.operation}
                    </Text>
                )}

                {gitWriteEnabled && (
                    <>
                        <Pressable
                            disabled={isReverting || !canRevert || Boolean(inFlightGitOperation)}
                            onPress={revertCommit}
                            style={{
                                marginTop: 10,
                                alignSelf: 'flex-start',
                                paddingHorizontal: 12,
                                paddingVertical: 7,
                                borderRadius: 8,
                                backgroundColor: theme.colors.warning,
                                opacity: isReverting || !canRevert || Boolean(inFlightGitOperation) ? 0.6 : 1,
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

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
                <GitDiffDisplay diffContent={diff} />
            </ScrollView>
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
